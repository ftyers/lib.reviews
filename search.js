'use strict';
const elasticsearch = require('elasticsearch');
const config = require('config');
const debug = require('./util/debug');
const client = new elasticsearch.Client({
  host: `${config.search.host}:${config.search.port}`,
  log: config.search.log
});
const mlString = require('./models/helpers/ml-string');
const languages = require('./locales/languages');

// All supported stemmers as of ElasticSearch 5.2.0
let analyzers = {
  ar: 'arabic',
  hy: 'armenian',
  eu: 'basque',
  pt: 'brazilian',
  bg: 'bulgarian',
  ca: 'catalan',
  zh: 'cjk',
  'zh-Hant': 'cjk',
  cs: 'czech',
  da: 'danish',
  nl: 'dutch',
  en: 'english',
  fi: 'finnish',
  fr: 'french',
  gl: 'galician',
  de: 'german',
  el: 'greek',
  hi: 'hindi',
  hu: 'hungarian',
  id: 'indonesian',
  ga: 'irish',
  it: 'italian',
  lv: 'latvian',
  lt: 'lithuanian',
  no: 'norwegian',
  fa: 'persian',
  'pt-PT': 'portuguese',
  ro: 'romanian',
  ru: 'russian',
  ckb: 'sorani',
  es: 'spanish',
  sv: 'swedish',
  tr: 'turkish',
  th: 'thai'
};


let search = {

  // For testing queries
  _raw(obj) {
    return client.search(obj);
  },

  // Find things by their label or description; performs language fallback
  searchThings(query, lang = 'en') {
    let options = search.getSearchOptions('things', 'label', lang);
    let descriptionOptions = search.getSearchOptions('things', 'description', lang);
    options.fields = options.fields.concat(descriptionOptions.fields);
    Object.assign(options.highlight.fields, descriptionOptions.highlight.fields);

    return client.search({
      index: 'libreviews',
      type: 'things',
      body: {
        query: {
          simple_query_string: {
            fields: options.fields,
            query,
            default_operator: 'and'
          }
        },
        highlight: options.highlight
      }
    });

  },

  // Find reviews by their text or title; performs language fallback and includes
  // the thing via parent-child join. The review is returned as an inner hit.
  searchReviews(query, lang = 'en') {
    // Add text fields
    let options = search.getSearchOptions('reviews', 'text', lang);

    // Add title fields
    let titleOptions = search.getSearchOptions('reviews', 'title', lang);
    options.fields = options.fields.concat(titleOptions.fields);

    Object.assign(options.highlight.fields, titleOptions.highlight.fields);
    return client.search({
      index: 'libreviews',
      type: 'things',
      body: {
        query: {
          has_child: {
            type: 'reviews',
            query: {
              simple_query_string: {
                fields: options.fields,
                query,
                default_operator: 'and'
              }
            },
            inner_hits: {
              highlight: options.highlight
            },
          }
        }
      }
    });
  },

  // We may be getting highlights from both the processed (stememd) index
  // and the unprocessed one. This function filters the dupes from inner hits.
  filterDuplicateInnerHighlights(hits, type) {
    for (let hit of hits) {
      if (hit.inner_hits && hit.inner_hits[type] && hit.inner_hits[type].hits) {
        for (let innerHit of hit.inner_hits[type].hits.hits) {
          if (innerHit.highlight) {
            let seenHighlights = [];
            for (let key in innerHit.highlight) {
              innerHit.highlight[key] = innerHit.highlight[key].filter(highlight => {
                if (seenHighlights.indexOf(highlight) === -1) {
                  seenHighlights.push(highlight);
                  return true;
                } else {
                  return false;
                }
              });
            }
          }
        }
      }
    }
    return hits;
  },

  // Generate language fallback and highlight options.
  getSearchOptions(type, fieldPrefix, lang) {
    let langs = languages.getFallbacks(lang);
    if (lang !== 'en')
      langs.unshift(lang);

    // Searches both stemmed and non-stemmed version
    let fields = langs.map(lang => `${fieldPrefix}.${lang}*`);

    // Add search highlighters
    let highlight = {
      pre_tags: ['<span class="search-highlight">'],
      post_tags: ['</span>'],
      fields: {}
    };
    for (let lang of langs)
      highlight.fields[`${fieldPrefix}.${lang}*`] = {};

    return {
      fields,
      highlight
    };

  },

  // Get search suggestions based on entered characters for review subjects
  // (things).
  suggestThing(prefix = '', lang = 'en') {
    // We'll query all fallbacks back to English, and return all results
    let langs = languages.getFallbacks(lang);
    if (lang !== 'en')
      langs.unshift(lang);

    let query = {
      index: 'libreviews',
      type: 'things',
      body: {
        suggest: {}
      }
    };

    for (let currentLanguage of langs) {
      query.body.suggest[`labels-${currentLanguage}`] = {
        prefix,
        completion: {
          field: `label.${currentLanguage}.completion`
        }
      };
    }

    return client.search(query);
  },

  // Index a new review. Returns a promise; logs errors
  indexReview(review) {
    return client.index({
        index: 'libreviews',
        type: 'reviews',
        id: review.id,
        parent: review.thingID,
        body: {
          createdOn: review.createdOn,
          title: mlString.stripHTML(review.title),
          text: mlString.stripHTML(review.html),
          starRating: review.starRating
        }
      })
      .catch(error => debug.error({
        error
      }));
  },

  // Index a new review subject (thing). Returns a promise; logs errors
  indexThing(thing) {
    return client.index({
        index: 'libreviews',
        type: 'things',
        id: thing.id,
        body: {
          createdOn: thing.createdOn,
          label: mlString.stripHTML(thing.label),
          aliases: mlString.stripHTMLFromArray(thing.aliases),
          description: mlString.stripHTML(thing.description),
          urls: thing.urls,
          urlID: thing.urlID
        }
      })
      .catch(error => debug.error({
        error
      }));
  },

  deleteThing(thing) {
    return client.delete({
        index: 'libreviews',
        type: 'things',
        id: thing.id
      })
      .catch(error => debug.error({
        error
      }));
  },

  deleteReview(review) {
    return client.delete({
        index: 'libreviews',
        type: 'reviews',
        parent: review.thing.id,
        id: review.id
      })
      .catch(error => debug.error({
        error
      }));
  },

  // Create the initial index for holding reviews and review subjects (things).
  // If index already exists, does nothing. Logs all other errors.
  createIndices() {
    return client.indices.create({
        index: 'libreviews',
        body: {
          settings: {
            analysis: {
              tokenizer: {
                whitespace: {
                  type: 'whitespace'
                }
              },
              analyzer: {
                label: {
                  type: 'custom',
                  tokenizer: 'whitespace',
                  filter: ['trim', 'lowercase']
                }
              }
            }
          },
          mappings: {
            reviews: {
              _parent: {
                type: 'things'
              },
              properties: {
                createdOn: {
                  type: 'date'
                },
                text: search.getMultilingualTextProperties(),
                title: search.getMultilingualTextProperties()
              }
            },
            things: {
              properties: {
                createdOn: {
                  type: 'date'
                },
                urls: search.getURLProperties(),
                label: search.getMultilingualTextProperties(true),
                aliases: search.getMultilingualTextProperties(true),
                description: search.getMultilingualTextProperties()
              }
            }
          }
        }
      })
      .catch(error => {
        if (/\[index_already_exists_exception\]/.test(error.message))
          return;
        debug.error({ error });
      });
  },

  // Generate the mappings (ElasticSearch schemas) for indexing URLs. We index
  // each URL three times to enable multiple search strategies
  getURLProperties() {
    return {
      // https://www.wikidata.org/wiki/Q27940587 -> https,www.wikidata.org,wiki,q27940587
      type: 'text',
      fields: {
        raw: {
          type: 'keyword' // https://www.wikidata.org/wiki/Q27940587 -> https://www.wikidata.org/wiki/Q27940587
        },
        simple: {
          type: 'text',
          analyzer: 'simple' // https,www,wikidata,org,wiki,q
        }
      }
    };
  },

  // Generate the mappings (ElasticSearch schemas) for indexing multilingual
  // strings
  getMultilingualTextProperties(completionMapping = false) {
    let obj = {
      properties: {}
    };

    let validLangs = languages.getValidLanguagesAndUndetermined();

    // We add all analyzers for all languages ElasticSearch has stemming support
    // for to the index, even if they're not yet supported by lib.reviews, so
    // we don't have to keep updating the index. Languages without analyzers
    // will be processed by the 'standard' analyzer (no stemming)
    for (let lang in analyzers) {

      // Splice from language array so we can process remaining languages differently
      let langPos = validLangs.indexOf(lang);
      if (langPos !== -1)
        validLangs.splice(langPos, 1);

      obj.properties[lang] = {
        type: 'text',
        index_options: 'offsets', // for sentence-based highlighting
        fields: {
          // The 'processed' property of the text field contains the stemmed
          // version (run through appropriate language analyzer) so we can
          // run searches against both the full text and the stemmed version,
          // as appropriate
          processed: {
            type: 'text',
            analyzer: analyzers[lang],
            index_options: 'offsets' // for sentence-based highlighting
          }
        }
      };
      if (completionMapping)
        obj.properties[lang].fields.completion = search.getCompletionMapping();
    }

    // Add remaining languages so we can do completion & offsets for those
    // as well.
    for (let lang of validLangs) {
      obj.properties[lang] = {
        type: 'text',
        index_options: 'offsets', // for sentence-based highlighting
      };
      if (completionMapping)
        obj.properties[lang].fields = {
          completion: search.getCompletionMapping()
        };
    }

    return obj;
  },

  // Return mapping for label autocompletion
  getCompletionMapping() {
    return {
      type: 'completion',
      analyzer: 'label',
      max_input_length: 256 // default is 50, our labels are 256
    };

  }

};

module.exports = search;
