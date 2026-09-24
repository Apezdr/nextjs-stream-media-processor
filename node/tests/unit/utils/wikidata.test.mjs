import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const axiosGet = jest.fn();
const getTmdbCache = jest.fn();
const setTmdbCache = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: { get: (...args) => axiosGet(...args) },
}));

jest.unstable_mockModule('../../../sqliteDatabase.mjs', () => ({
  getTmdbCache: (...args) => getTmdbCache(...args),
  setTmdbCache: (...args) => setTmdbCache(...args),
}));

const {
  getWikidataRatingEnrichment,
  resetWikidataRuntimeStateForTests,
} = await import('../../../utils/wikidata.mjs');

const jsonResponse = (data, headers = {}) => ({
  data,
  status: 200,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
});

const entitySnak = (id) => ({
  snaktype: 'value',
  datavalue: { type: 'wikibase-entityid', value: { id } },
});

const stringSnak = (value) => ({
  snaktype: 'value',
  datavalue: { type: 'string', value },
});

const timeSnak = (time) => ({
  snaktype: 'value',
  datavalue: { type: 'time', value: { time } },
});

const claim = ({
  ratingQid = 'Q18665344',
  rank = 'normal',
  descriptors = [],
  p2676 = '55720',
  p14671 = null,
} = {}) => ({
  id: 'Q136163067$statement-guid',
  rank,
  mainsnak: entitySnak(ratingQid),
  qualifiers: {
    ...(descriptors.length ? { P7367: descriptors.map(entitySnak) } : {}),
    ...(p2676 ? { P2676: [stringSnak(p2676)] } : {}),
    ...(p14671 ? { P14671: [stringSnak(p14671)] } : {}),
  },
  references: [{
    snaks: {
      P854: [stringSnak('https://www.filmratings.com/Content/Downloads/cara_rating_bulletin.pdf')],
      P123: [entitySnak('Q676222')],
      P577: [timeSnak('+2026-03-25T00:00:00Z')],
    },
  }],
});

function mockEntity({
  qid = 'Q136163067',
  imdbIds = ['tt37287335'],
  claims = [claim()],
} = {}) {
  return {
    entities: {
      [qid]: {
        claims: {
          P345: imdbIds.map((imdbId) => ({ mainsnak: stringSnak(imdbId) })),
          P1657: claims,
        },
      },
    },
  };
}

function mockSearch(...qids) {
  return { query: { search: qids.map((title) => ({ title })) } };
}

describe('Wikidata rating enrichment provider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetWikidataRuntimeStateForTests();
    getTmdbCache.mockResolvedValue(null);
    setTmdbCache.mockResolvedValue(true);
  });

  it('maps a stable TMDB/IMDb identity to compatible rating provenance and certificate data', async () => {
    axiosGet
      .mockResolvedValueOnce(jsonResponse(mockSearch('Q136163067')))
      .mockResolvedValueOnce(jsonResponse(mockEntity()));

    const result = await getWikidataRatingEnrichment({
      tmdbId: '1339713',
      imdbId: 'tt37287335',
      allowNetwork: true,
    });

    expect(result).toEqual({
      schema: 1,
      entityId: 'Q136163067',
      tmdbMovieId: '1339713',
      imdbId: 'tt37287335',
      contentRating: 'R',
      ratingEntityId: 'Q18665344',
      descriptors: [],
      certificateId: '55720',
      certificateProperty: 'P2676',
      statementId: 'Q136163067$statement-guid',
      referenceUrl: 'https://www.filmratings.com/Content/Downloads/cara_rating_bulletin.pdf',
      referencePublisherId: 'Q676222',
      referencePublicationDate: '2026-03-25',
      retrievedAt: expect.any(String),
    });
    expect(axiosGet).toHaveBeenCalledTimes(2);
    expect(axiosGet.mock.calls[0]).toEqual([
      'https://www.wikidata.org/w/api.php',
      expect.objectContaining({
        maxRedirects: 0,
        maxContentLength: 256 * 1024,
        proxy: false,
        params: {
          action: 'query',
          list: 'search',
          srsearch: 'haswbstatement:P4947=1339713',
          srnamespace: 0,
          srlimit: 2,
          format: 'json',
          formatversion: 2,
          maxlag: 5,
        },
      }),
    ]);
    expect(setTmdbCache).toHaveBeenCalledWith(
      'wikidata:/movie-rating/v1',
      { tmdb_id: '1339713' },
      { schema: 1, status: 'hit', data: result },
      1440,
    );
  });

  it('resolves descriptor QIDs only when the selected rating statement carries them', async () => {
    axiosGet
      .mockResolvedValueOnce(jsonResponse(mockSearch('Q1')))
      .mockResolvedValueOnce(jsonResponse(mockEntity({
        qid: 'Q1',
        claims: [claim({ descriptors: ['Q60300342', 'Q12345'] })],
      })))
      .mockResolvedValueOnce(jsonResponse({
        entities: {
          Q60300342: { labels: { en: { value: 'Strong Language' } } },
          Q12345: { labels: { en: { value: '<script>bad</script>' } } },
        },
      }));

    const result = await getWikidataRatingEnrichment({
      tmdbId: 123,
      imdbId: 'tt37287335',
      allowNetwork: true,
    });

    expect(result.descriptors).toEqual(['Strong Language']);
    expect(axiosGet).toHaveBeenCalledTimes(3);
  });

  it('prefers P14671, but omits a conflicting certificate pair', async () => {
    axiosGet
      .mockResolvedValueOnce(jsonResponse(mockSearch('Q1')))
      .mockResolvedValueOnce(jsonResponse(mockEntity({
        qid: 'Q1',
        claims: [claim({ p2676: '111', p14671: '222' })],
      })));

    const result = await getWikidataRatingEnrichment({
      tmdbId: 123,
      imdbId: 'tt37287335',
      allowNetwork: true,
    });

    expect(result).not.toHaveProperty('certificateId');
    expect(result).not.toHaveProperty('certificateProperty');
  });

  it('rejects invalid IDs before cache or network access', async () => {
    await expect(getWikidataRatingEnrichment({
      tmdbId: '123; DROP',
      imdbId: 'not-imdb',
      allowNetwork: true,
    })).resolves.toBeNull();

    expect(getTmdbCache).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('treats multiple identity hits and IMDb mismatch as terminal misses', async () => {
    axiosGet.mockResolvedValueOnce(jsonResponse(mockSearch('Q1', 'Q2')));
    await expect(getWikidataRatingEnrichment({
      tmdbId: 123,
      imdbId: 'tt37287335',
      allowNetwork: true,
    })).resolves.toBeNull();

    expect(setTmdbCache).toHaveBeenLastCalledWith(
      'wikidata:/movie-rating/v1',
      { tmdb_id: '123' },
      { schema: 1, status: 'ambiguous' },
      168,
    );

    jest.clearAllMocks();
    getTmdbCache.mockResolvedValue(null);
    setTmdbCache.mockResolvedValue(true);
    axiosGet
      .mockResolvedValueOnce(jsonResponse(mockSearch('Q1')))
      .mockResolvedValueOnce(jsonResponse(mockEntity({ qid: 'Q1', imdbIds: ['tt0000000'] })));

    await expect(getWikidataRatingEnrichment({
      tmdbId: 123,
      imdbId: 'tt37287335',
      allowNetwork: true,
    })).resolves.toBeNull();
    expect(setTmdbCache).toHaveBeenLastCalledWith(
      'wikidata:/movie-rating/v1',
      { tmdb_id: '123' },
      { schema: 1, status: 'identity-conflict' },
      168,
    );
  });

  it('rejects conflicting best-rank classifications without merging qualifiers', async () => {
    axiosGet
      .mockResolvedValueOnce(jsonResponse(mockSearch('Q1')))
      .mockResolvedValueOnce(jsonResponse(mockEntity({
        qid: 'Q1',
        claims: [claim(), claim({ ratingQid: 'Q18665339', p2676: null })],
      })));

    await expect(getWikidataRatingEnrichment({
      tmdbId: 123,
      allowNetwork: true,
    })).resolves.toBeNull();
    expect(axiosGet).toHaveBeenCalledTimes(2);
  });

  it('uses positive and negative cache entries without repeated network calls', async () => {
    const positive = {
      schema: 1,
      status: 'hit',
      data: {
        schema: 1,
        entityId: 'Q1',
        tmdbMovieId: '123',
        contentRating: 'R',
        ratingEntityId: 'Q18665344',
        descriptors: [],
      },
    };
    getTmdbCache.mockResolvedValueOnce({ data: positive });

    await expect(getWikidataRatingEnrichment({ tmdbId: 123 })).resolves.toEqual(positive.data);
    expect(axiosGet).not.toHaveBeenCalled();

    getTmdbCache.mockResolvedValueOnce({ data: { schema: 1, status: 'miss' } });
    await expect(getWikidataRatingEnrichment({ tmdbId: 456 })).resolves.toBeNull();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('revalidates and sanitizes positive cache entries before returning them', async () => {
    getTmdbCache.mockResolvedValueOnce({
      data: {
        schema: 1,
        status: 'hit',
        data: {
          schema: 1,
          entityId: 'Q1',
          tmdbMovieId: '123',
          contentRating: 'R',
          ratingEntityId: 'Q18665344',
          descriptors: ['Strong Language', '\u061cHidden direction'],
          certificateId: '<script>',
          certificateProperty: 'P2676',
          referenceUrl: 'javascript:alert(1)',
        },
      },
    });

    await expect(getWikidataRatingEnrichment({ tmdbId: 123 })).resolves.toEqual({
      schema: 1,
      entityId: 'Q1',
      tmdbMovieId: '123',
      contentRating: 'R',
      ratingEntityId: 'Q18665344',
      descriptors: ['Strong Language'],
    });
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('does not durable-cache malformed search responses as authoritative misses', async () => {
    axiosGet.mockResolvedValueOnce(jsonResponse({ query: {} }));

    await expect(getWikidataRatingEnrichment({
      tmdbId: 123,
      allowNetwork: true,
    })).resolves.toBeNull();
    expect(setTmdbCache).not.toHaveBeenCalled();
  });

  it('keeps cache-only misses and provider failures nonfatal without durable false negatives', async () => {
    await expect(getWikidataRatingEnrichment({
      tmdbId: 123,
      allowNetwork: false,
    })).resolves.toBeNull();
    expect(axiosGet).not.toHaveBeenCalled();
    expect(setTmdbCache).not.toHaveBeenCalled();

    axiosGet.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    await expect(getWikidataRatingEnrichment({
      tmdbId: 123,
      allowNetwork: true,
    })).resolves.toBeNull();
    expect(setTmdbCache).not.toHaveBeenCalled();
  });

  it('opens a local backoff gate after a 429 without issuing the next request', async () => {
    axiosGet.mockRejectedValueOnce(Object.assign(new Error('rate limited'), {
      response: { status: 429, headers: { 'retry-after': '60' } },
    }));

    await expect(getWikidataRatingEnrichment({
      tmdbId: 123,
      allowNetwork: true,
    })).resolves.toBeNull();
    await expect(getWikidataRatingEnrichment({
      tmdbId: 456,
      allowNetwork: true,
    })).resolves.toBeNull();
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it('does no cache or network work for television', async () => {
    await expect(getWikidataRatingEnrichment({
      mediaType: 'tv',
      tmdbId: 123,
      allowNetwork: true,
    })).resolves.toBeNull();
    expect(getTmdbCache).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('joins concurrent lookups for the same cache key', async () => {
    let releaseSearch;
    const pendingSearch = new Promise((resolve) => { releaseSearch = resolve; });
    axiosGet
      .mockImplementationOnce(() => pendingSearch)
      .mockResolvedValueOnce(jsonResponse(mockEntity({ qid: 'Q1' })));

    const first = getWikidataRatingEnrichment({ tmdbId: 123, allowNetwork: true });
    const second = getWikidataRatingEnrichment({ tmdbId: 123, allowNetwork: true });
    releaseSearch(jsonResponse(mockSearch('Q1')));

    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(axiosGet).toHaveBeenCalledTimes(2);
  });
});
