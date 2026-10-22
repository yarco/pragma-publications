import test from 'node:test';
import assert from 'node:assert/strict';

import {
    bindingsFromPersonXml,
    fetchPersonXmlBindings,
    loadDblpBindings,
    publicationsFromBindings
} from '../lib/publications.mjs';
import { DBLP_PROFILES } from '../lib/config.mjs';

const PAPER = 'https://dblp.org/rec/conf/example/Paper';
const PREPRINT = 'https://dblp.org/rec/journals/corr/Paper';

const PERSON_XML = `<?xml version="1.0"?>
<dblpperson>
  <person><author pid="09/2790">Myeongjae Jeon</author></person>
  <r>
    <inproceedings key="conf/example/Paper">
      <author>Sam H. Noh 0001</author>
      <author>Myeongjae Jeon</author>
      <title>Paper.</title>
      <pages>1-10</pages>
      <year>2023</year>
      <booktitle>EuroSys</booktitle>
    </inproceedings>
  </r>
  <r>
    <article publtype="informal" key="journals/corr/Paper">
      <author>Myeongjae Jeon</author>
      <title>Paper.</title>
      <year>2023</year>
      <journal>CoRR</journal>
    </article>
  </r>
  <r>
    <proceedings key="conf/example/2023">
      <editor>Myeongjae Jeon</editor>
      <title>Proceedings.</title>
      <year>2023</year>
      <booktitle>EuroSys</booktitle>
    </proceedings>
  </r>
  <coauthors><co n="1">ignored</co></coauthors>
</dblpperson>`;

const quiet = {
    log() {},
    onSourceFailure() {}
};

test('person XML maps inproceedings and informal articles into bindings', () => {
    assert.deepEqual(publicationsFromBindings(bindingsFromPersonXml(PERSON_XML)), [
        {
            author: 'Sam H. Noh, Myeongjae Jeon',
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
    const uris = bindingsFromPersonXml(PERSON_XML).map(row => row.pub.value);
    assert.equal(uris.includes(PAPER), true);
    assert.equal(uris.includes(PREPRINT), true);
    assert.equal(uris.some(uri => uri.includes('proceedings')), false);
});

test('person XML rejects a pid that would escape the DBLP path', async () => {
    await assert.rejects(
        () => fetchPersonXmlBindings([{ pid: '../admin', name: 'x' }], {
            fetchImpl() {
                throw new Error('network must not be called');
            }
        }),
        /invalid DBLP pid/
    );
});

test('SPARQL stays primary when it returns publications', async () => {
    let backups = 0;
    const bindings = await loadDblpBindings(DBLP_PROFILES, {
        ...quiet,
        sources: [
            {
                id: 'sparql',
                load: async () => [{ pub: { value: PAPER }, title: { value: 'Paper.' } }]
            },
            {
                id: 'person-xml',
                load: async () => {
                    backups += 1;
                    return [];
                }
            }
        ]
    });
    assert.equal(backups, 0);
    assert.equal(bindings[0].pub.value, PAPER);
});

test('an empty primary result falls through to the next backup', async () => {
    const seen = [];
    const bindings = await loadDblpBindings(DBLP_PROFILES, {
        ...quiet,
        sources: [
            { id: 'sparql', load: async () => { seen.push('sparql'); return []; } },
            {
                id: 'person-xml',
                load: async () => {
                    seen.push('person-xml');
                    return [{ pub: { value: PAPER }, title: { value: 'From XML.' } }];
                }
            }
        ]
    });
    assert.deepEqual(seen, ['sparql', 'person-xml']);
    assert.equal(bindings[0].title.value, 'From XML.');
});

test('a dead SPARQL source falls through and a total failure keeps every cause', async () => {
    const notes = [];
    const bindings = await loadDblpBindings(DBLP_PROFILES, {
        log() {},
        onSourceFailure(event) { notes.push(event.source); },
        sources: [
            { id: 'sparql', load: async () => { throw new Error('connect timeout'); } },
            {
                id: 'person-xml',
                load: async () => [{ pub: { value: PAPER }, title: { value: 'From XML.' } }]
            }
        ]
    });
    assert.deepEqual(notes, ['sparql']);
    assert.equal(bindings[0].title.value, 'From XML.');

    const failure = await loadDblpBindings(DBLP_PROFILES, {
        ...quiet,
        sources: [
            { id: 'sparql', load: async () => { throw new Error('connect timeout'); } },
            { id: 'person-xml', load: async () => { throw new Error('challenge refused'); } }
        ]
    }).then(() => null, error => error);
    assert.match(failure.message, /sparql: connect timeout/);
    assert.match(failure.message, /person-xml: challenge refused/);
    assert.equal(failure.cause.message, 'challenge refused');
});

test('the default fan uses person XML only after SPARQL fails', async () => {
    let sparqlCalls = 0;
    const urls = [];
    const bindings = await loadDblpBindings(DBLP_PROFILES, {
        ...quiet,
        retries: 1,
        backoffMs: 0,
        fetchImpl: async url => {
            urls.push(String(url));
            if (String(url).includes('sparql')) {
                sparqlCalls += 1;
                throw Object.assign(new TypeError('fetch failed'), {
                    cause: new Error('Connect Timeout Error')
                });
            }
            return new Response(PERSON_XML, {
                status: 200,
                headers: { 'content-type': 'application/xml' }
            });
        }
    });
    assert.equal(sparqlCalls, 1);
    assert.equal(urls.filter(url => url.endsWith('.xml')).length, DBLP_PROFILES.length);
    assert.equal(bindings.some(row => row.pub.value === PAPER), true);
    assert.equal(urls.some(url => url.includes('honeypot')), false);
});

test('person XML retries a 503 and does not retry a refused challenge', async () => {
    let calls = 0;
    const bindings = await fetchPersonXmlBindings([{ pid: '09/2790', name: 'Myeongjae Jeon' }], {
        retries: 2,
        backoffMs: 0,
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return new Response('unavailable', { status: 503 });
            return new Response(PERSON_XML, {
                status: 200,
                headers: { 'content-type': 'application/xml' }
            });
        }
    });
    assert.equal(calls, 2);
    assert.equal(bindings.length > 0, true);

    let refused = 0;
    await assert.rejects(
        () => fetchPersonXmlBindings([{ pid: '09/2790', name: 'Myeongjae Jeon' }], {
            retries: 3,
            backoffMs: 0,
            fetchImpl: async () => {
                refused += 1;
                const headers = new Headers();
                headers.set('content-type', 'text/html');
                headers.set('refresh', '0; url=/.within.website/x/cmd/anubis/api/pass-challenge');
                const body = '<script id="anubis_challenge" type="application/json">'
                    + '{"rules":{"algorithm":"fast"},"challenge":{"method":"fast"}}</script>';
                return new Response(body, { status: 202, headers });
            }
        }),
        /not metarefresh/
    );
    assert.equal(refused, 1);
});
