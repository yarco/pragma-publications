// Anubis metarefresh client for dblp.org.
//
// The site asks a non-browser client to wait, then request one same-origin
// pass URL carried in the Refresh header (or the matching meta tag). This
// module does that and nothing else: no browser User-Agent, no proof-of-work
// solver, and no request to the honeypot link in the challenge HTML. Any
// other challenge algorithm fails closed.

import { FETCH_TIMEOUT_MS, USER_AGENT } from './config.mjs';

const PASS_PATH = '/.within.website/x/cmd/anubis/api/pass-challenge';
const MAX_REFRESH_SECONDS = 15;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fail(message, retryable, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.retryable = retryable;
    return error;
}

function unescapeHtml(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function parseRefresh(value) {
    const match = String(value).trim().match(/^(\d+)\s*;\s*url\s*=\s*(.*)$/i);
    if (!match) return null;
    return {
        seconds: Number(match[1]),
        target: unescapeHtml(match[2].trim())
    };
}

function metaRefresh(html) {
    const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
    for (const tag of tags) {
        if (!/http-equiv\s*=\s*["']refresh["']/i.test(tag)) continue;
        const content = tag.match(/content\s*=\s*["']([^"']*)["']/i);
        if (!content) continue;
        const parsed = parseRefresh(content[1]);
        if (parsed) return parsed;
    }
    return null;
}

function readChallenge(html) {
    const match = html.match(
        /<script\b[^>]*\bid=["']anubis_challenge["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (!match) return null;
    let payload;
    try {
        payload = JSON.parse(match[1]);
    } catch (error) {
        throw fail('DBLP Anubis challenge JSON is unreadable', false, error);
    }
    return {
        method: payload?.challenge?.method ?? null,
        algorithm: payload?.rules?.algorithm ?? null
    };
}

function refreshInstruction(headers, html) {
    const fromHeader = parseRefresh(headers.get('refresh') ?? '');
    const fromMeta = metaRefresh(html);
    if (fromHeader && fromMeta && fromHeader.target !== fromMeta.target) {
        throw fail('DBLP Anubis refresh header and meta tag disagree', false);
    }
    const found = fromHeader ?? fromMeta;
    if (!found) {
        throw fail('DBLP Anubis metarefresh challenge has no refresh URL', false);
    }
    if (found.seconds > MAX_REFRESH_SECONDS) {
        throw fail(
            `DBLP Anubis refresh delay ${found.seconds}s is not metarefresh`,
            false
        );
    }
    return found;
}

function passUrl(pageUrl, target) {
    let absolute;
    try {
        absolute = new URL(target, pageUrl);
    } catch (error) {
        throw fail('DBLP Anubis pass URL is unreadable', false, error);
    }
    if (absolute.origin !== new URL(pageUrl).origin) {
        throw fail('DBLP Anubis pass URL is off-origin', false);
    }
    if (absolute.pathname.includes('honeypot')) {
        throw fail('DBLP Anubis pass URL is a honeypot', false);
    }
    if (absolute.pathname !== PASS_PATH) {
        throw fail('DBLP Anubis pass URL is not pass-challenge', false);
    }
    return absolute;
}

export class CookieJar {
    constructor() {
        this.pairs = new Map();
    }

    absorb(response, now = Date.now()) {
        const lines = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : [];
        for (const line of lines) this.store(line, now);
    }

    store(line, now) {
        const [pair, ...attrs] = line.split(';').map(part => part.trim());
        const eq = pair.indexOf('=');
        if (eq <= 0) return;
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        const flags = new Map(attrs.map(attr => {
            const splitAt = attr.indexOf('=');
            return splitAt < 0
                ? [attr.toLowerCase(), '']
                : [attr.slice(0, splitAt).toLowerCase(), attr.slice(splitAt + 1)];
        }));
        const maxAge = flags.get('max-age');
        const expires = flags.get('expires');
        const expired = value === ''
            || (maxAge != null && Number(maxAge) <= 0)
            || (expires != null && Number.isFinite(Date.parse(expires)) && Date.parse(expires) <= now);
        if (expired) this.pairs.delete(name);
        else this.pairs.set(name, value);
    }

    header() {
        if (this.pairs.size === 0) return undefined;
        return [...this.pairs].map(([name, value]) => `${name}=${value}`).join('; ');
    }
}

function isXml(page) {
    const type = page.contentType ?? '';
    const head = page.text.trimStart().slice(0, 80);
    return (/xml/i.test(type) && head.startsWith('<'))
        || head.startsWith('<?xml')
        || head.startsWith('<dblpperson');
}

function isChallenge(page) {
    return page.status === 202 || /id=["']anubis_challenge["']/i.test(page.text);
}

async function request(url, {
    fetchImpl,
    jar,
    timeoutMs,
    now,
    redirect = 'follow'
}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = {
            'User-Agent': USER_AGENT,
            Accept: 'application/xml, text/xml;q=0.9, */*;q=0.8'
        };
        const cookie = jar.header();
        if (cookie) headers.Cookie = cookie;
        const response = await fetchImpl(url, {
            method: 'GET',
            redirect,
            signal: controller.signal,
            headers
        });
        jar.absorb(response, now());
        return {
            status: response.status,
            text: await response.text(),
            headers: response.headers,
            contentType: response.headers.get('content-type')
        };
    } catch (error) {
        if (error?.retryable === false) throw error;
        if (error?.name === 'AbortError') {
            throw fail(`Timed out after ${timeoutMs}ms fetching DBLP ${url}`, true, error);
        }
        error.retryable = true;
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * GET one dblp.org document. A metarefresh challenge is answered in place.
 * The returned string is the document body.
 */
export async function fetchThroughAnubis(url, {
    fetchImpl = fetch,
    jar = new CookieJar(),
    sleepImpl = sleep,
    timeoutMs = FETCH_TIMEOUT_MS,
    now = () => Date.now()
} = {}) {
    const first = await request(url, { fetchImpl, jar, timeoutMs, now });
    if (isXml(first)) return first.text;
    if (!isChallenge(first)) {
        const retryable = first.status === 429 || first.status >= 500 || first.status === 0;
        throw fail(`DBLP ${url} returned HTTP ${first.status}`, retryable);
    }

    const challenge = readChallenge(first.text);
    if (!challenge) {
        throw fail('DBLP Anubis challenge has no anubis_challenge JSON', false);
    }
    if (challenge.method !== 'metarefresh' || challenge.algorithm !== 'metarefresh') {
        throw fail(
            `DBLP Anubis challenge is ${challenge.method ?? 'unknown'}/${challenge.algorithm ?? 'unknown'}, not metarefresh`,
            false
        );
    }

    const instruction = refreshInstruction(first.headers, first.text);
    const pass = passUrl(url, instruction.target);
    await sleepImpl(instruction.seconds * 1000);
    const passed = await request(pass.toString(), {
        fetchImpl, jar, timeoutMs, now, redirect: 'manual'
    });
    if (![301, 302, 303, 307, 308].includes(passed.status)) {
        const retryable = passed.status === 429 || passed.status >= 500;
        throw fail(`DBLP Anubis pass returned HTTP ${passed.status}`, retryable);
    }

    const second = await request(url, { fetchImpl, jar, timeoutMs, now });
    if (!isXml(second)) {
        throw fail(`DBLP ${url} was still blocked after metarefresh`, true);
    }
    return second.text;
}
