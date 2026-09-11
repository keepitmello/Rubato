const BM25_K1 = 0.9;
const BM25_B = 0.4;
const DEFAULT_LIMIT = 25;

export function buildBm25Index(docs) {
  const indexed = docs.map(indexDocument);
  const documentFrequency = new Map();
  for (const entry of indexed) {
    for (const term of entry.termFrequency.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const totalLength = indexed.reduce((sum, entry) => sum + entry.length, 0);
  const averageLength = indexed.length === 0 ? 0 : totalLength / indexed.length;

  return {
    search(query, limit = DEFAULT_LIMIT, options = {}) {
      const queryTerms = tokenizeToolText(query);
      if (queryTerms.length === 0) return [];
      const normalizedQuery = normalizeToolName(query);
      const results = [];
      for (const entry of indexed) {
        if (options.source !== undefined && entry.doc.source !== options.source) continue;
        if (options.group !== undefined && entry.doc.group !== options.group) continue;
        const exact = options.exactMatch !== false && entry.exactNames.has(normalizedQuery);
        const score = scoreDocument(entry, queryTerms, documentFrequency, averageLength, indexed.length);
        if (exact || score > 0) results.push({ doc: entry.doc, exact, name: entry.doc.name, score });
      }
      results.sort((left, right) => {
        if (left.exact !== right.exact) return left.exact ? -1 : 1;
        if (right.score !== left.score) return right.score - left.score;
        return left.name.localeCompare(right.name);
      });
      return results.slice(0, Math.max(0, limit));
    },
  };
}

function indexDocument(doc) {
  const termFrequency = new Map();
  addField(termFrequency, tokenizeToolText(doc.name), 3);
  addField(termFrequency, tokenizeToolText(doc.label), 3);
  for (const alias of doc.aliases) addField(termFrequency, tokenizeToolText(alias), 3);
  for (const keyword of doc.keywords) addField(termFrequency, tokenizeToolText(keyword), 3);
  addField(termFrequency, tokenizeToolText(doc.group), 2);
  addField(termFrequency, tokenizeToolText(doc.ownerLabel), 2);
  addField(termFrequency, tokenizeToolText(doc.description ?? ""), 1);
  addField(termFrequency, tokenizeToolText(doc.searchText ?? ""), 1);
  return {
    doc,
    exactNames: new Set([doc.name, doc.label, ...doc.aliases, ...doc.keywords].map(normalizeToolName)),
    length: [...termFrequency.values()].reduce((sum, count) => sum + count, 0),
    termFrequency,
  };
}

function addField(frequencies, tokens, weight) {
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + weight);
}

function scoreDocument(entry, queryTerms, documentFrequency, averageLength, documentCount) {
  let score = 0;
  const seen = new Set();
  for (const term of queryTerms) {
    if (seen.has(term)) continue;
    seen.add(term);
    const frequency = entry.termFrequency.get(term);
    if (frequency === undefined) continue;
    const seenDocuments = documentFrequency.get(term) ?? 0;
    const inverseFrequency = Math.log(1 + (documentCount - seenDocuments + 0.5) / (seenDocuments + 0.5));
    const denominator = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * entry.length) / (averageLength || 1));
    score += inverseFrequency * ((frequency * (BM25_K1 + 1)) / (denominator || 1));
  }
  return score;
}

export function tokenizeToolText(text) {
  const separated = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return separated.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((part) => part.toLowerCase());
}

export function normalizeToolName(name) {
  return name.toLowerCase().replace(/[-_\s]+/g, "");
}
