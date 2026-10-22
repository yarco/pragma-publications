import test from 'node:test';
import assert from 'node:assert/strict';

import { CookieJar, fetchThroughAnubis } from '../lib/anubis.mjs';
import { USER_AGENT } from '../lib/config.mjs';

const PAGE = 'https://dblp.org/pid/09/2790.xml';
const PASS_PATH = '/.within.website/x/cmd/anubis/api/pass-challenge';
const XML = '<?xml version="1.0"?><dblpperson n="1"></dblpperson>';

function challengeBody({ method = 'metarefresh', algorithm = 'metarefresh', meta = '' } = {}) {
    return `<!doctype html><html><head><title>Making sure you're not a bot!</title>${meta}</head>`
        + `<body><script id="anubis_challenge" type="application/json">`
        + `${JSON.stringify({
            rules: { algorithm, difficulty: 1 },
            challenge: { method }
        })}</script>`
        + `<a href="/.within.website/x/cmd/anubis/api/honeypot/do-not-click/init">trap</a>`
        + `</body></html>`;
}

function challengeResponse(refresh, extra = {}) {
    const headers = new Headers();
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('refresh', refresh);
    headers.append('set-cookie', 'dblp_org-cookie-verification-test=challenge-id; Path=/; Secure');
    headers.append(
        'set-cookie',
        'dblp_org-auth-test=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    );
    return new Response(challengeBody(extra), { status: 202, headers });
}

function passResponse() {
    const headers = new Headers();
    headers.set('location', '/pid/09/2790.xml');
    headers.append('set-cookie', 'dblp_org-auth-test=auth-token; Path=/; Secure');
    return new Response('', { status: 302, headers });
}

function xmlResponse() {
    return new Response(XML, {
        status: 200,
        headers: { 'content-type': 'application/xml' }
    });
}

test('an expired auth cookie is dropped and a live verification cookie is kept', () => {
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append('set-cookie', 'verification=abc; Path=/');
    headers.append('set-cookie', 'auth=stale; Path=/; Max-Age=0');
    jar.absorb(new Response('', { headers }), Date.parse('2026-10-22T00:00:00Z'));
    assert.equal(jar.header(), 'verification=abc');
});

test('metarefresh waits, passes same-origin, and returns the document', async () => {
    const seen = [];
    const sleeps = [];
    const xml = await fetchThroughAnubis(PAGE, {
        sleepImpl: ms => {
            sleeps.push(ms);
            return Promise.resolve();
        },
        fetchImpl: async (url, init) => {
            seen.push({ url, init });
            if (seen.length === 1) {
                return challengeResponse(
                    '2; url=/.within.website/x/cmd/anubis/api/pass-challenge?id=1&redir=%2Fpid%2F09%2F2790.xml'
                );
            }
            if (seen.length === 2) return passResponse();
            return xmlResponse();
        }
    });

    assert.equal(xml, XML);
    assert.deepEqual(sleeps, [2000]);
    assert.equal(seen.length, 3);
    assert.equal(new URL(seen[1].url).pathname, PASS_PATH);
    assert.equal(seen[1].init.redirect, 'manual');
    assert.equal(seen[1].init.headers.Cookie, 'dblp_org-cookie-verification-test=challenge-id');
    assert.equal(seen[2].init.headers.Cookie.includes('dblp_org-auth-test=auth-token'), true);
    assert.equal(seen[0].init.headers['User-Agent'], USER_AGENT);
    assert.equal(seen[0].init.headers['User-Agent'].includes('Mozilla'), false);
    assert.equal(seen.some(call => call.url.includes('honeypot')), false);
});

test('a proof-of-work challenge is refused without a second request', async () => {
    let calls = 0;
    await assert.rejects(
        fetchThroughAnubis(PAGE, {
            fetchImpl: async () => {
                calls += 1;
                return challengeResponse('0; url=/.within.website/x/cmd/anubis/api/pass-challenge', {
                    method: 'fast',
                    algorithm: 'fast'
                });
            }
        }),
        /not metarefresh/
    );
    assert.equal(calls, 1);
});

test('an off-origin pass URL is refused', async () => {
    let calls = 0;
    await assert.rejects(
        fetchThroughAnubis(PAGE, {
            fetchImpl: async () => {
                calls += 1;
                return challengeResponse('2; url=https://evil.example/pass-challenge');
            }
        }),
        /off-origin/
    );
    assert.equal(calls, 1);
});

test('the honeypot path is refused even when it is the refresh target', async () => {
    let calls = 0;
    await assert.rejects(
        fetchThroughAnubis(PAGE, {
            fetchImpl: async () => {
                calls += 1;
                return challengeResponse(
                    '2; url=/.within.website/x/cmd/anubis/api/honeypot/abc/init'
                );
            }
        }),
        /honeypot/
    );
    assert.equal(calls, 1);
});

test('disagreeing refresh header and meta tag are fatal', async () => {
    await assert.rejects(
        fetchThroughAnubis(PAGE, {
            fetchImpl: async () => challengeResponse(
                '2; url=/.within.website/x/cmd/anubis/api/pass-challenge?id=1',
                {
                    meta: '<meta http-equiv="refresh" content="2; url=https://evil.example/pass">'
                }
            )
        }),
        /disagree/
    );
});

test('an XML document skips the challenge', async () => {
    let calls = 0;
    const xml = await fetchThroughAnubis(PAGE, {
        fetchImpl: async () => {
            calls += 1;
            return xmlResponse();
        }
    });
    assert.equal(calls, 1);
    assert.equal(xml, XML);
});

test('HTTP 503 is retryable and HTTP 400 is not', async () => {
    const unavailable = await fetchThroughAnubis(PAGE, {
        fetchImpl: async () => new Response('no', { status: 503 })
    }).then(() => null, error => error);
    const rejected = await fetchThroughAnubis(PAGE, {
        fetchImpl: async () => new Response('no', { status: 400 })
    }).then(() => null, error => error);
    assert.equal(unavailable.retryable, true);
    assert.equal(rejected.retryable, false);
});
