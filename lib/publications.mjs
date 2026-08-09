// DBLP + Google Sites publication pipeline.
// Pure data logic: no HTTP server and no runtime cache.

import { JSDOM } from 'jsdom';
import seedrandom from 'seedrandom';
import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fuzzball from 'fuzzball';

import {
    DBLP_URLS,
    WEBPAGE_URL,
    SHUFFLE_SEED,
    FETCH_TIMEOUT_MS,
    FETCH_RETRIES,
    FETCH_BACKOFF_MS,
    USER_AGENT
} from './config.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const isRetryableStatus = status => status === 429 || status === 503 || status >= 500;

/**
 * Fetch with a hard timeout and bounded backoff. The original had neither, so a
 * slow DBLP could hang a request indefinitely and a 503 failed the whole run.
 */
async function fetchXml(url) {
    let lastError;

    for (let attempt = 1; attempt <= FETCH_RETRIES; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let retryable = true;

        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml' }
            });

            if (response.ok) return await response.text();

            lastError = new Error(
                `Network response was not ok for ${url}: ${response.status} ${response.statusText}`
            );
            // A 404 or 401 will not fix itself. Retrying it only burns time and
            // makes us look worse to a rate limiter. Note this must not `throw`
            // here: the sibling catch below would swallow it and retry anyway.
            retryable = isRetryableStatus(response.status);
        } catch (error) {
            lastError = error.name === 'AbortError'
                ? new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms fetching ${url}`)
                : error;
        } finally {
            clearTimeout(timer);
        }

        if (!retryable) break;
        if (attempt < FETCH_RETRIES) await sleep(FETCH_BACKOFF_MS * attempt);
    }

    throw lastError ?? new Error(`Failed to fetch ${url}`);
}

function parseXml(xmlString) {
    const { DOMParser } = new JSDOM().window;
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');
    const parserError = doc.querySelector('parsererror');
    if (parserError) {
        console.error("XML Parsing Error:", parserError.textContent);
        throw new Error("Failed to parse XML string.");
    }
    return doc;
}

function extractPublications(xmlDom) {
    const inproceedings = Array.from(xmlDom.querySelectorAll('inproceedings'));
    const articles = Array.from(xmlDom.querySelectorAll('article'));
    return [...inproceedings, ...articles];
}

/** Remove the same DBLP record when co-authors' profile feeds overlap. */
export function deduplicatePublications(publications) {
    const seenKeys = new Set();
    return publications.filter(publication => {
        const key = publication.getAttribute?.('key')?.trim();
        if (!key) return true;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
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

function publicationToJson(publication) {
    const result = {};
    const authors = Array.from(publication.querySelectorAll('author'));
    if (authors.length > 0) {
        const authorNames = authors.map(author => author.textContent.replace(/\s*\d+\s*$/, '').trim()).filter(name => name); // Filter out empty names
        if (authorNames.length > 0) {
            result.author = authorNames.join(', ');
        }
    }
    const title = publication.querySelector('title');
    if (title) result.title = title.textContent;

    const journal = publication.querySelector('journal');
    const booktitle = publication.querySelector('booktitle');
    const yearElement = publication.querySelector('year');

    if ((journal || booktitle) && yearElement) {
        const venueText = journal ? journal.textContent : booktitle.textContent;
        result.venue = `${venueText} ${yearElement.textContent}`;
    }

    if (yearElement) {
        const yearText = yearElement.textContent;
        const parsedYear = parseInt(yearText, 10);
        result.year = isNaN(parsedYear) ? yearText : parsedYear;
    } else if (result.venue && !yearElement) { // If venue exists but year element is missing, try to parse year from venue string
        const yearMatchInVenue = result.venue.match(/\b(19|20)\d{2}\b$/); // Match year at the end of venue string
        if (yearMatchInVenue) {
            const parsedYear = parseInt(yearMatchInVenue[0], 10);
            if (!isNaN(parsedYear)) result.year = parsedYear;
        }
    }


    const pages = publication.querySelector('pages');
    if (pages) result.pages = pages.textContent;
    return result;
}

async function mergeXml(urls, seed) {
    const xmlPromises = urls.map(url => fetchXml(url));
    const xmlStrings = await Promise.all(xmlPromises);
    const xmlDoms = xmlStrings.map(parseXml);
    let allPublications = [];
    xmlDoms.forEach(xmlDom => allPublications.push(...extractPublications(xmlDom)));
    allPublications = deduplicatePublications(allPublications);
    allPublications = shuffleArray(allPublications, seed);
    const groupedByYear = {};
    allPublications.forEach(publication => {
        const publicationJson = publicationToJson(publication);
        const year = publicationJson.year;
        if (!groupedByYear[year]) groupedByYear[year] = [];
        groupedByYear[year].push(publicationJson);
    });
    const sortedYears = Object.keys(groupedByYear).sort((a, b) => {
        const aIsNum = !isNaN(parseInt(a, 10));
        const bIsNum = !isNaN(parseInt(b, 10));
        if (aIsNum && bIsNum) return parseInt(b, 10) - parseInt(a, 10);
        if (!aIsNum && !bIsNum) return a.localeCompare(b);
        return !aIsNum ? -1 : 1;
    });
    const result = {};
    sortedYears.forEach(year => result[year] = groupedByYear[year]);
    return result;
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


function findBestMatch(webpageTitle, dblpData) {
    let bestMatch = null;
    let bestScore = 0;
    for (const year in dblpData) {
        if (year === 'selected') continue;
        for (const pub of dblpData[year]) {
            if (pub.title) {
                const score = fuzzball.ratio(webpageTitle.toLowerCase(), pub.title.toLowerCase());
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = pub;
                }
            }
        }
    }
    return bestScore > 80 ? bestMatch : null;
}

/**
 * Build the full publications payload: every DBLP publication grouped by year,
 * plus a `selected` list reconciled against the author's own webpage.
 */
export async function processData() {
    const dblpMergedData = await mergeXml(DBLP_URLS, SHUFFLE_SEED);

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
