import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildSparqlQuery,
    cleanAuthorName,
    fetchSparqlBindings,
    findBestMatch,
    groupPublicationsByYear,
    publicationsFromBindings
} from '../lib/publications.mjs';
import { DBLP_PROFILES } from '../lib/config.mjs';

const uri = value => ({ type: 'uri', value });
const lit = (value, extra = {}) => ({ type: 'literal', value, ...extra });

const row = ({
    pub,
    title,
    year,
    venue,
    pages,
    ord,
    authorName
}) => {
    const binding = {};
    if (pub) binding.pub = uri(pub);
    if (title) binding.title = lit(title);
    if (year != null) {
        binding.year = lit(String(year), {
            datatype: 'http://www.w3.org/2001/XMLSchema#gYear'
        });
    }
    if (venue) binding.venue = lit(venue);
    if (pages) binding.pages = lit(pages);
    if (ord != null) {
        binding.ord = lit(String(ord), {
            datatype: 'http://www.w3.org/2001/XMLSchema#int'
        });
    }
    if (authorName) binding.authorName = lit(authorName);
    return binding;
};

const PAPER = 'https://dblp.org/rec/conf/example/Paper';
const PREPRINT = 'https://dblp.org/rec/journals/corr/Paper';

test('cleanAuthorName strips trailing DBLP disambiguation integers', () => {
    assert.equal(cleanAuthorName('Sam H. Noh 0001'), 'Sam H. Noh');
    assert.equal(cleanAuthorName('Myeongjae Jeon'), 'Myeongjae Jeon');
    assert.equal(cleanAuthorName('Youngjae Kim 2'), 'Youngjae Kim');
});

test('buildSparqlQuery asks SPARQL for the XML-equivalent publication types', () => {
    const query = buildSparqlQuery();
    for (const profile of DBLP_PROFILES) {
        assert.match(query, new RegExp(`https://dblp.org/pid/${profile.pid}`));
    }
    assert.match(query, /dblp:Inproceedings/);
    assert.match(query, /dblp:Article/);
    assert.match(query, /dblp:Informal/);
    assert.match(query, /dblp:AuthorSignature/);
    assert.match(query, /dblp:signatureOrdinal/);
    assert.equal(query.includes('.xml'), false);
    assert.equal(query.includes('dblp:Editorship'), false);
});

test('buildSparqlQuery rejects a pid that would break SPARQL injection guards', () => {
    assert.throws(
        () => buildSparqlQuery([{ pid: '163/1540> } . ?x <https://evil', name: 'x' }]),
        /invalid DBLP pid/
    );
});

test('REGRESSION: overlapping coauthor rows deduplicate by record URI', () => {
    const bindings = [
        row({
            pub: PAPER, title: 'Paper.', year: 2023, venue: 'EuroSys',
            pages: '1-10', ord: 1, authorName: 'Myeongjae Jeon'
        }),
        row({
            pub: PAPER, title: 'Paper.', year: 2023, venue: 'EuroSys',
            pages: '1-10', ord: 2, authorName: 'Youngjae Kim'
        }),
        // Same paper seen again via the second author PID.
        row({
            pub: PAPER, title: 'Paper.', year: 2023, venue: 'EuroSys',
            pages: '1-10', ord: 1, authorName: 'Myeongjae Jeon'
        }),
        row({
            pub: PREPRINT, title: 'Paper.', year: 2023, venue: 'CoRR',
            ord: 1, authorName: 'Myeongjae Jeon'
        })
    ];

    assert.deepEqual(publicationsFromBindings(bindings), [
        {
            author: 'Myeongjae Jeon, Youngjae Kim',
            title: 'Paper.',
            year: 2023,
            venue: 'EuroSys 2023',
            pages: '1-10'
        },
        {
            author: 'Myeongjae Jeon',
            title: 'Paper.',
            year: 2023,
            venue: 'CoRR 2023'
        }
    ]);
});

test('authors are ordered by signature ordinal, not SPARQL row order', () => {
    const bindings = [
        row({
            pub: PAPER, title: 'Paper.', year: 2024, venue: 'OSDI',
            ord: 3, authorName: 'Sam H. Noh 0001'
        }),
        row({
            pub: PAPER, title: 'Paper.', year: 2024, venue: 'OSDI',
            ord: 1, authorName: 'Myeongjae Jeon'
        }),
        row({
            pub: PAPER, title: 'Paper.', year: 2024, venue: 'OSDI',
            ord: 2, authorName: 'Youngjae Kim'
        })
    ];

    assert.deepEqual(publicationsFromBindings(bindings), [{
        author: 'Myeongjae Jeon, Youngjae Kim, Sam H. Noh',
        title: 'Paper.',
        year: 2024,
        venue: 'OSDI 2024'
    }]);
});

test('published objects omit key/uri and omit empty optional fields', () => {
    const [pub] = publicationsFromBindings([
        row({ pub: PAPER, title: 'Untitled-only.', year: 2011 })
    ]);
    assert.equal(Object.hasOwn(pub, 'key'), false);
    assert.equal(Object.hasOwn(pub, 'uri'), false);
    assert.equal(Object.hasOwn(pub, 'pages'), false);
    assert.equal(Object.hasOwn(pub, 'venue'), false);
    assert.equal(Object.hasOwn(pub, 'author'), false);
    assert.deepEqual(pub, { title: 'Untitled-only.', year: 2011 });
});

test('a later SPARQL row can fill optional fields left unbound on the first', () => {
    const [pub] = publicationsFromBindings([
        row({ pub: PAPER, title: 'Paper.', ord: 1, authorName: 'A' }),
        row({
            pub: PAPER, title: 'Paper.', year: 2020, venue: 'ATC',
            pages: '10-12', ord: 2, authorName: 'B'
        })
    ]);
    assert.deepEqual(pub, {
        author: 'A, B',
        title: 'Paper.',
        year: 2020,
        venue: 'ATC 2020',
        pages: '10-12'
    });
});

test('groupPublicationsByYear keeps integer year buckets (JS enumerates them ascending)', () => {
    const grouped = groupPublicationsByYear([
        { title: 'old', year: 2007 },
        { title: 'new', year: 2026 },
        { title: 'mid', year: 2019 }
    ]);
    // Integer-like keys are own-index properties, so Object.keys/JSON.stringify
    // emit them ascending regardless of insertion order. That is the live
    // publications.json shape (2007 ... 2026, then selected).
    assert.deepEqual(Object.keys(grouped), ['2007', '2019', '2026']);
    assert.equal(grouped['2026'][0].title, 'new');
    assert.equal(grouped['2007'][0].title, 'old');
});

test('rows without a publication URI are ignored rather than guessed', () => {
    assert.deepEqual(
        publicationsFromBindings([
            row({ title: 'No URI.', year: 2020, venue: 'X' }),
            row({ pub: PAPER, title: 'Has URI.', year: 2020, venue: 'X' })
        ]),
        [{ title: 'Has URI.', year: 2020, venue: 'X 2020' }]
    );
});

test('REGRESSION: transient SPARQL 503 is retried', async () => {
    let calls = 0;
    const bindings = await fetchSparqlBindings('https://sparql.example/sparql', 'SELECT * WHERE {}', {
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return new Response('unavailable', { status: 503, statusText: 'Service Unavailable' });
            return new Response(JSON.stringify({ results: { bindings: [{ ok: { value: '1' } }] } }), {
                status: 200,
                headers: { 'Content-Type': 'application/sparql-results+json' }
            });
        },
        backoffMs: 0
    });
    assert.equal(calls, 2);
    assert.equal(bindings[0].ok.value, '1');
});

test('non-retryable SPARQL HTTP status fails immediately', async () => {
    let calls = 0;
    await assert.rejects(
        fetchSparqlBindings('https://sparql.example/sparql', 'SELECT * WHERE {}', {
            fetchImpl: async () => {
                calls += 1;
                return new Response('no', { status: 400, statusText: 'Bad Request' });
            },
            backoffMs: 0
        }),
        /returned HTTP 400/
    );
    assert.equal(calls, 1);
});

test('SPARQL 200 without a bindings array is fatal', async () => {
    await assert.rejects(
        fetchSparqlBindings('https://sparql.example/sparql', 'SELECT * WHERE {}', {
            fetchImpl: async () => new Response(JSON.stringify({ results: {} }), { status: 200 }),
            backoffMs: 0
        }),
        /missing results\.bindings/
    );
});

test('REGRESSION: identical DBLP titles prefer the paginated proceedings record over CoRR', () => {
    const dblpData = {
        2023: [
            {
                title: 'Cost-effective On-device Continual Learning over Memory Hierarchy with Miro.',
                year: 2023,
                venue: 'CoRR 2023',
                author: 'A'
            },
            {
                title: 'Cost-effective On-device Continual Learning over Memory Hierarchy with Miro.',
                year: 2023,
                venue: 'MobiCom 2023',
                pages: '83:1-83:15',
                author: 'A'
            }
        ]
    };
    assert.deepEqual(
        findBestMatch(
            'Cost-effective On-device Continual Learning over Memory Hierarchy with Miro',
            dblpData
        ).venue,
        'MobiCom 2023'
    );
});
