// DBLP + Google Sites publication pipeline.
// SPARQL is the primary source. Backups are the rest of DBLP_SOURCE_FAN.
// Pure data logic: no HTTP server and no runtime cache.

import seedrandom from 'seedrandom';
import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fuzzball from 'fuzzball';

import { CookieJar, fetchThroughAnubis } from './anubis.mjs';
import { describeErrorChain } from './failure-report.mjs';
import {
    DBLP_PROFILES,
    DBLP_SPARQL_ENDPOINT,
    DBLP_PERSON_URI_PREFIX,
    WEBPAGE_URL,
    SHUFFLE_SEED,
    FETCH_TIMEOUT_MS,
    FETCH_RETRIES,
    FETCH_BACKOFF_MS,
    USER_AGENT
} from './config.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const isRetryableStatus = status => status === 429 || status >= 500;

// Person-page XML extracted <inproceedings> and <article>, the latter including
// publtype="informal" (CoRR / arXiv). Those three RDF classes are the same set.
const DBLP_PUBLICATION_TYPES = ['Inproceedings', 'Article', 'Informal'];

function assertPid(pid) {
    const value = String(pid ?? '');
    if (!value || /[\s<>"{}\\]/.test(value) || value.includes('..')) {
        throw new Error(`invalid DBLP pid: ${pid}`);
    }
}

function personUri(pid) {
    assertPid(pid);
    return `<${DBLP_PERSON_URI_PREFIX}${pid}>`;
}

function personXmlUrl(pid) {
    assertPid(pid);
    return `${DBLP_PERSON_URI_PREFIX}${pid}.xml`;
}

/** SPARQL query that returns one row per author-signature of each matching paper. */
export function buildSparqlQuery(profiles = DBLP_PROFILES) {
    const authorValues = profiles.map(profile => personUri(profile.pid)).join(' ');
    const typeValues = DBLP_PUBLICATION_TYPES.map(type => `dblp:${type}`).join(' ');
    return `PREFIX dblp: <https://dblp.org/rdf/schema#>
SELECT ?pub ?title ?year ?venue ?pages ?ord ?authorName WHERE {
  {
    SELECT DISTINCT ?pub WHERE {
      VALUES ?authorPid { ${authorValues} }
      VALUES ?type { ${typeValues} }
      ?pub a ?type ;
           dblp:authoredBy ?authorPid .
    }
  }
  ?pub dblp:title ?title .
  OPTIONAL { ?pub dblp:yearOfPublication ?year . }
  OPTIONAL { ?pub dblp:publishedIn ?venue . }
  OPTIONAL { ?pub dblp:pagination ?pages . }
  OPTIONAL {
    ?pub dblp:hasSignature ?sig .
    ?sig a dblp:AuthorSignature ;
         dblp:signatureOrdinal ?ord ;
         dblp:signatureDblpName ?authorName .
  }
}`;
}

function bindingValue(row, name) {
    const term = row?.[name];
    if (!term || term.value == null || term.value === '') return undefined;
    return term.value;
}

/** Strip the trailing disambiguation integer DBLP appends to author names. */
export function cleanAuthorName(name) {
    return String(name).replace(/\s*\d+\s*$/, '').trim();
}

function recordToPublication(record) {
    const result = {};
    const authorNames = [...record.authors.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, name]) => cleanAuthorName(name))
        .filter(Boolean);
    if (authorNames.length > 0) result.author = authorNames.join(', ');
    if (record.title) result.title = record.title;

    const yearText = record.year;
    if (yearText != null) {
        const parsedYear = parseInt(yearText, 10);
        result.year = isNaN(parsedYear) ? yearText : parsedYear;
    }
    if (record.venue && yearText != null) {
        result.venue = `${record.venue} ${yearText}`;
    }
    if (record.pages) result.pages = record.pages;
    return result;
}

/**
 * Collapse SPARQL rows (one per author signature, possibly repeated when
 * coauthors share a paper) into the published publication objects.
 * Dedup is by record URI, which is the SPARQL form of the XML `key`.
 */
export function publicationsFromBindings(bindings) {
    const grouped = new Map();

    for (const row of bindings) {
        const uri = bindingValue(row, 'pub');
        if (!uri) continue;

        let record = grouped.get(uri);
        if (!record) {
            record = {
                title: undefined,
                year: undefined,
                venue: undefined,
                pages: undefined,
                authors: new Map()
            };
            grouped.set(uri, record);
        }

        record.title ??= bindingValue(row, 'title');
        record.year ??= bindingValue(row, 'year');
        record.venue ??= bindingValue(row, 'venue');
        record.pages ??= bindingValue(row, 'pages');

        const ordinalRaw = bindingValue(row, 'ord');
        const authorName = bindingValue(row, 'authorName');
        if (ordinalRaw != null && authorName) {
            const ordinal = Number(ordinalRaw);
            if (Number.isFinite(ordinal) && !record.authors.has(ordinal)) {
                record.authors.set(ordinal, authorName);
            }
        }
    }

    return [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, record]) => recordToPublication(record));
}

export function groupPublicationsByYear(publications) {
    const groupedByYear = {};
    for (const publication of publications) {
        const year = publication.year;
        if (!groupedByYear[year]) groupedByYear[year] = [];
        groupedByYear[year].push(publication);
    }
    const sortedYears = Object.keys(groupedByYear).sort((a, b) => {
        const aIsNum = !isNaN(parseInt(a, 10));
        const bIsNum = !isNaN(parseInt(b, 10));
        if (aIsNum && bIsNum) return parseInt(b, 10) - parseInt(a, 10);
        if (!aIsNum && !bIsNum) return a.localeCompare(b);
        return !aIsNum ? -1 : 1;
    });
    const result = {};
    for (const year of sortedYears) result[year] = groupedByYear[year];
    return result;
}

/**
 * POST a SPARQL SELECT and return `results.bindings`. Retries 429/5xx the same
 * way the old XML fetch did; a 4xx or a 200 with no bindings array is fatal.
 */
export async function fetchSparqlBindings(endpoint, query, {
    fetchImpl = fetch,
    timeoutMs = FETCH_TIMEOUT_MS,
    retries = FETCH_RETRIES,
    backoffMs = FETCH_BACKOFF_MS
} = {}) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let retryable = true;

        try {
            const response = await fetchImpl(endpoint, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: 'application/sparql-results+json',
                    'Content-Type': 'application/sparql-query'
                },
                body: query
            });

            if (!response.ok) {
                lastError = new Error(
                    `SPARQL ${endpoint} returned HTTP ${response.status} ${response.statusText}`
                );
                retryable = isRetryableStatus(response.status);
            } else {
                let payload;
                try {
                    payload = await response.json();
                } catch (error) {
                    lastError = new Error(
                        `SPARQL ${endpoint} returned non-JSON body`,
                        { cause: error }
                    );
                    payload = null;
                }

                if (payload) {
                    const bindings = payload?.results?.bindings;
                    if (!Array.isArray(bindings)) {
                        lastError = new Error(
                            `SPARQL ${endpoint} response missing results.bindings`
                        );
                        retryable = false;
                    } else {
                        return bindings;
                    }
                }
            }
        } catch (error) {
            lastError = error.name === 'AbortError'
                ? new Error(`Timed out after ${timeoutMs}ms querying SPARQL ${endpoint}`)
                : error;
        } finally {
            clearTimeout(timer);
        }

        if (!retryable) break;
        if (attempt < retries) await sleep(backoffMs * attempt);
    }

    throw lastError ?? new Error(`Failed to query SPARQL ${endpoint}`);
}

function xmlBinding({ pub, title, year, venue, pages, ord, authorName }) {
    const row = {
        pub: { type: 'uri', value: pub },
        title: { type: 'literal', value: title }
    };
    if (year) row.year = { type: 'literal', value: year };
    if (venue) row.venue = { type: 'literal', value: venue };
    if (pages) row.pages = { type: 'literal', value: pages };
    if (ord != null && authorName) {
        row.ord = { type: 'literal', value: String(ord) };
        row.authorName = { type: 'literal', value: authorName };
    }
    return row;
}

/** Map one dblp person document into the same rows SPARQL bindings use. */
export function bindingsFromPersonXml(xml) {
    const $ = cheerio.load(xml, { xmlMode: true });
    const bindings = [];
    $('dblpperson > r').each((_, record) => {
        $(record).children('inproceedings, article').each((__, node) => {
            const publication = $(node);
            const key = publication.attr('key');
            const title = publication.children('title').first().text().trim();
            if (!key || !title) return;
            const year = publication.children('year').first().text().trim();
            const venue = publication.children('booktitle').first().text().trim()
                || publication.children('journal').first().text().trim();
            const pages = publication.children('pages').first().text().trim();
            const authors = publication.children('author').toArray();
            const base = {
                pub: `https://dblp.org/rec/${key}`,
                title,
                year,
                venue,
                pages
            };
            if (authors.length === 0) {
                bindings.push(xmlBinding(base));
                return;
            }
            authors.forEach((author, index) => {
                bindings.push(xmlBinding({
                    ...base,
                    ord: index + 1,
                    authorName: $(author).text().trim()
                }));
            });
        });
    });
    return bindings;
}

async function withRetries(work, {
    retries = FETCH_RETRIES,
    backoffMs = FETCH_BACKOFF_MS
} = {}) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            return await work();
        } catch (error) {
            lastError = error;
            if (error?.retryable !== true) break;
            if (attempt < retries) await sleep(backoffMs * attempt);
        }
    }
    throw lastError;
}

/** Fetch each PID's person page through one shared Anubis cookie jar. */
export async function fetchPersonXmlBindings(profiles = DBLP_PROFILES, options = {}) {
    const jar = options.jar ?? new CookieJar();
    const bindings = [];
    for (const profile of profiles) {
        const url = personXmlUrl(profile.pid);
        const xml = await withRetries(
            () => fetchThroughAnubis(url, { ...options, jar }),
            options
        );
        bindings.push(...bindingsFromPersonXml(xml));
    }
    return bindings;
}

function loadSparql(profiles, options) {
    return fetchSparqlBindings(
        DBLP_SPARQL_ENDPOINT,
        buildSparqlQuery(profiles),
        options
    );
}

function loadPersonXml(profiles, options) {
    return fetchPersonXmlBindings(profiles, options);
}

// Index 0 is the primary source. Each later entry is a backup and runs only
// after every earlier source throws or returns no publications.
export const DBLP_SOURCE_FAN = Object.freeze([
    Object.freeze({ id: 'sparql', load: loadSparql }),
    Object.freeze({ id: 'person-xml', load: loadPersonXml })
]);

function reportSourceFailure({ source, error, backup }) {
    const next = backup ? '; trying the next DBLP source' : '';
    console.error(`[dblp] ${source} failed: ${describeErrorChain(error)}${next}`);
}

/**
 * Try the source fan in order. The first source with at least one publication
 * wins, which is SPARQL whenever that endpoint answers.
 */
export async function loadDblpBindings(profiles = DBLP_PROFILES, {
    sources = DBLP_SOURCE_FAN,
    log = console.log,
    onSourceFailure = reportSourceFailure,
    ...sourceOptions
} = {}) {
    const failures = [];
    for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        try {
            const bindings = await source.load(profiles, sourceOptions);
            if (!Array.isArray(bindings) || bindings.length === 0) {
                throw new Error(`${source.id} returned no publications`);
            }
            log(`[dblp] using ${source.id}`);
            return bindings;
        } catch (error) {
            failures.push({ id: source.id, error });
            onSourceFailure({
                source: source.id,
                error,
                backup: index < sources.length - 1
            });
        }
    }
    const summary = failures
        .map(({ id, error }) => `${id}: ${error.message}`)
        .join('; ');
    throw new Error(`Every DBLP source failed (${summary})`, {
        cause: failures.at(-1)?.error
    });
}


function shuffleArray(array, seed) {
    const rng = seedrandom(seed);
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

async function fetchWebpage(url) {
    const response = await axios.get(url, {
        timeout: FETCH_TIMEOUT_MS,
        headers: { 'User-Agent': USER_AGENT }
    });
    return cheerio.load(response.data);
}

function extractStructuredWebPublications($) {
    const publications = [];
    const authorPlaceholder = 'Authors not automatically extracted';
    const venuePlaceholder = 'Venue not automatically extracted';

    $('ol.n8H08c.BKnRcf > li.zfr3Q.TYR86d.lsiHE').each((_, liElement) => {
        const $li = $(liElement);
        const titleParagraph = $li.children('p.zfr3Q.CDt4Ke').first();
        let title = titleParagraph.find('span.C9DxTc[style*="font-weight: 700"]').first().text().trim();

        if (!title) {
            title = titleParagraph.find('span.C9DxTc[style*="font-size: 12.0pt"][style*="font-family: Lato, Arial"]').first().text().trim();
        }
        if (!title) return;

        title = title.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        title = title.replace(/\s*\[\s*(pdf|slides|video|link|code|talk|extended|benchmark)\s*\](?:\s*\.\s*)?$/gi, '').trim();
        title = title.replace(/\.$/, '').trim();
        if (!title) return;

        let authors = authorPlaceholder;
        let venueString = venuePlaceholder;
        let year = new Date().getFullYear(); // Default, overridden if parsed

        const nestedOl = $li.children('ol.n8H08c.BKnRcf').first();
        const detailsUl = nestedOl.children('li.zfr3Q.TYR86d.lsiHE[style*="list-style-type: none"]').first().children('ul.n8H08c.UVNKR').first();

        if (detailsUl.length > 0) {
            const detailItems = detailsUl.children('li.zfr3Q.TYR86d.eD0Rn');
            if (detailItems.length > 0) {
                const parsedAuthors = $(detailItems[0]).find('p.zfr3Q.CDt4Ke span.C9DxTc').map((i, el) => $(el).text().trim()).get().join(' ').replace(/\s+/g, ' ').trim();
                if (parsedAuthors) authors = parsedAuthors;
            }
            if (detailItems.length > 1) {
                const venueYearParagraph = $(detailItems[1]).find('p.zfr3Q.CDt4Ke');
                let venueYearText = venueYearParagraph.text().trim().replace(/\s+/g, ' ');

                const yearMatch = venueYearText.match(/\b(19|20)\d{2}\b/);
                if (yearMatch && yearMatch[0]) {
                    const parsedYearNum = parseInt(yearMatch[0], 10);
                    if (!isNaN(parsedYearNum)) year = parsedYearNum;
                }

                let venueOnly = venueYearText;
                if (yearMatch && yearMatch[0]) {
                    const venueRegex = new RegExp(`^(.*?)(?:,\\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\.\\s*)?${yearMatch[0]}`);
                    const venueContentMatch = venueYearText.match(venueRegex);
                    if (venueContentMatch && venueContentMatch[1]) {
                        venueOnly = venueContentMatch[1].trim();
                    } else {
                        const yearIdx = venueYearText.indexOf(yearMatch[0]);
                        if (yearIdx !== -1) venueOnly = venueYearText.substring(0, yearIdx).trim();
                    }
                    venueOnly = venueOnly.replace(/,$/, '').trim();
                }
                venueOnly = venueOnly.replace(/\s*\[\s*(pdf|slides|video|link|code|talk|extended|benchmark)\s*\]/gi, '').trim();
                if (venueOnly) venueString = venueOnly;
            }
        }

        const pubData = {
            title: title,
            year: year, // 'year' field (numeric or string like "In Press") is always included
            source: 'webpage_extracted'
        };

        if (authors !== authorPlaceholder) {
            pubData.author = authors;
        }
        if (venueString !== venuePlaceholder) {
            pubData.venue = `${venueString} ${year}`; // DBLP-like venue string including the year
        }
        // 'pages' field is omitted as it's not typically available or is "N/A"

        publications.push(pubData);
    });
    return publications;
}


function isInformalVenue(pub) {
    const venue = (pub?.venue || '').toLowerCase();
    return venue.includes('corr') || venue.includes('arxiv');
}

/** Prefer the proceedings/journal record when DBLP also has the CoRR preprint. */
function publicationRank(pub) {
    let rank = 0;
    if (pub.pages) rank += 2;
    if (!isInformalVenue(pub)) rank += 1;
    return rank;
}

export function findBestMatch(webpageTitle, dblpData) {
    let bestMatch = null;
    let bestScore = 0;
    let bestRank = -1;
    const needle = webpageTitle.toLowerCase();
    for (const year in dblpData) {
        if (year === 'selected') continue;
        for (const pub of dblpData[year]) {
            if (!pub.title) continue;
            const score = fuzzball.ratio(needle, pub.title.toLowerCase());
            if (score <= 80) continue;
            const rank = publicationRank(pub);
            if (score > bestScore || (score === bestScore && rank > bestRank)) {
                bestScore = score;
                bestRank = rank;
                bestMatch = pub;
            }
        }
    }
    return bestMatch;
}

/**
 * Build the full publications payload: every DBLP publication grouped by year,
 * plus a `selected` list reconciled against the author's own webpage.
 */
export async function processData() {
    const bindings = await loadDblpBindings(DBLP_PROFILES);
    const publications = publicationsFromBindings(bindings);
    if (publications.length === 0) {
        throw new Error('DBLP returned no publications');
    }
    const dblpMergedData = groupPublicationsByYear(
        shuffleArray(publications, SHUFFLE_SEED)
    );

    const $ = await fetchWebpage(WEBPAGE_URL);
    const webpageStructuredPublications = extractStructuredWebPublications($);

    const selectedPublications = webpageStructuredPublications.map(webPub => {
        const dblpMatch = findBestMatch(webPub.title, dblpMergedData);
        if (!dblpMatch) return webPub;

        const finalPub = { ...dblpMatch };

        if (typeof webPub.year === 'number' && typeof finalPub.year === 'number'
            && webPub.year > finalPub.year) {
            finalPub.year = webPub.year;
            if (finalPub.venue) {
                finalPub.venue = finalPub.venue.replace(/\b(19|20)\d{2}\b$/, webPub.year.toString());
            }
        }

        if (!Object.hasOwn(finalPub, 'year') && Object.hasOwn(webPub, 'year')) {
            finalPub.year = webPub.year;
            if (finalPub.venue && !/\b(19|20)\d{2}\b/.test(finalPub.venue)) {
                finalPub.venue = `${finalPub.venue} ${webPub.year}`;
            } else if (!finalPub.venue && webPub.venue) {
                finalPub.venue = webPub.venue;
            }
        }

        return finalPub;
    });

    const sorted = [...selectedPublications].sort((a, b) => {
        const aIsNum = Number.isFinite(a.year);
        const bIsNum = Number.isFinite(b.year);

        if (!aIsNum && bIsNum) return -1;
        if (aIsNum && !bIsNum) return 1;
        if (!aIsNum && !bIsNum) {
            const yearCompare = a.year.toString().localeCompare(b.year.toString());
            return yearCompare !== 0 ? yearCompare : (a.title || '').localeCompare(b.title || '');
        }
        return b.year - a.year;
    });

    return { ...dblpMergedData, selected: sorted };
}

/** Count publications across every year bucket, excluding `selected`. */
export function countPublications(data) {
    if (!data || typeof data !== 'object') return 0;
    return Object.keys(data)
        .filter(key => key !== 'selected')
        .reduce((total, year) => total + (Array.isArray(data[year]) ? data[year].length : 0), 0);
}
