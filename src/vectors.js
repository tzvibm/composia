/**
 * Composia Vectors — semantic search via TF-IDF vector embeddings.
 *
 * Every note gets a vector computed from its content + summary + tags.
 * Vectors are stored in a RocksDB sublevel and searched via cosine similarity.
 *
 * This is a local-first approach — no API calls, instant, works offline.
 * Accurate enough for code knowledge graphs where terminology is domain-specific.
 *
 * How it works:
 *   1. Build vocabulary from all notes (top N terms by document frequency)
 *   2. For each note, compute TF-IDF vector against that vocabulary
 *   3. Store vectors in the `vectors` sublevel
 *   4. Search by computing query vector and finding nearest neighbors
 */

// ── Text processing ─────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'this', 'that',
  'these', 'those', 'it', 'its', 'my', 'your', 'his', 'her', 'our',
  'their', 'what', 'which', 'who', 'whom', 'up', 'about', 'also',
  'return', 'new', 'null', 'undefined', 'true', 'false', 'const', 'let',
  'var', 'function', 'class', 'import', 'export', 'default', 'async',
  'await', 'try', 'catch', 'throw', 'if', 'else', 'for', 'while',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')           // strip code blocks
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1') // wikilinks → text
    .replace(/[^a-z0-9_-]+/g, ' ')             // non-alpha to spaces
    .split(/\s+/)
    .filter(w => w.length > 2 && w.length < 40 && !STOP_WORDS.has(w));
}

function noteText(note) {
  const parts = [
    note.title || '',
    note.content || '',
    typeof note.summary === 'object' ? note.summary.body || '' : note.summary || '',
    (note.tags || []).join(' '),
    (note.summary?.keywords || []).join(' '),
  ];
  return parts.join(' ');
}

// ── TF-IDF engine ───────────────────────────────────────

const VOCAB_SIZE = 512;

export class VectorIndex {
  constructor(engine) {
    this.engine = engine;
    this.vectors = engine.db.sublevel('vectors', { valueEncoding: 'json' });
    this.vocabSub = engine.db.sublevel('vocab', { valueEncoding: 'json' });
    this.vocab = null;      // term → index
    this.idf = null;        // term → idf score
    this.vocabList = null;  // index → term
  }

  /**
   * Build vocabulary from all notes and compute vectors.
   * Call this after bulk note insertion (e.g., after `composia map`).
   */
  async buildIndex() {
    // Collect all notes
    const notes = [];
    for await (const [, note] of this.engine.notes.iterator()) {
      notes.push(note);
    }
    if (notes.length === 0) return { indexed: 0 };

    // Step 1: Build document frequency map
    const df = new Map(); // term → number of docs containing it
    const docTokens = new Map(); // noteId → tokens

    for (const note of notes) {
      const tokens = tokenize(noteText(note));
      const unique = new Set(tokens);
      docTokens.set(note.id, tokens);
      for (const term of unique) {
        df.set(term, (df.get(term) || 0) + 1);
      }
    }

    // Step 2: Pick top VOCAB_SIZE terms by document frequency
    // Filter: must appear in at least 2 docs but not more than 80% of docs
    const maxDf = Math.max(2, Math.floor(notes.length * 0.8));
    const candidates = [...df.entries()]
      .filter(([, count]) => count >= 2 && count <= maxDf)
      .sort((a, b) => b[1] - a[1])
      .slice(0, VOCAB_SIZE);

    this.vocabList = candidates.map(([term]) => term);
    this.vocab = new Map(this.vocabList.map((term, i) => [term, i]));

    // Step 3: Compute IDF scores
    const N = notes.length;
    this.idf = new Map();
    for (const [term, count] of df.entries()) {
      if (this.vocab.has(term)) {
        this.idf.set(term, Math.log(N / (1 + count)));
      }
    }

    // Step 4: Compute and store TF-IDF vectors
    const batch = [];
    for (const note of notes) {
      const tokens = docTokens.get(note.id);
      const vec = this._computeVector(tokens);
      batch.push({ type: 'put', sublevel: this.vectors, key: note.id, value: vec });
    }

    // Save vocabulary
    batch.push({ type: 'put', sublevel: this.vocabSub, key: '_vocab', value: this.vocabList });
    batch.push({ type: 'put', sublevel: this.vocabSub, key: '_idf', value: Object.fromEntries(this.idf) });

    await this.engine.db.batch(batch);

    return { indexed: notes.length, vocabSize: this.vocabList.length };
  }

  /**
   * Index a single note (after save). Requires vocabulary to be built first.
   */
  async indexNote(noteId) {
    await this._ensureVocab();
    if (!this.vocab) return;

    const note = await this.engine.getNote(noteId).catch(() => null);
    if (!note) return;

    const tokens = tokenize(noteText(note));
    const vec = this._computeVector(tokens);
    await this.vectors.put(noteId, vec);
  }

  /**
   * Semantic search — find notes most similar to a query string.
   * Returns [{ id, score, title, summary }] sorted by similarity.
   */
  async search(query, { limit = 20, threshold = 0.05 } = {}) {
    await this._ensureVocab();
    if (!this.vocab || this.vocab.size === 0) return [];

    const queryTokens = tokenize(query);
    const queryVec = this._computeVector(queryTokens);
    const queryMag = magnitude(queryVec);
    if (queryMag === 0) return [];

    const results = [];
    for await (const [noteId, vec] of this.vectors.iterator()) {
      if (noteId.startsWith('_')) continue; // skip metadata
      const sim = cosine(queryVec, vec, queryMag);
      if (sim >= threshold) {
        results.push({ id: noteId, score: Math.round(sim * 1000) / 1000 });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);

    // Hydrate with note data
    for (const r of top) {
      const note = await this.engine.getNote(r.id).catch(() => null);
      if (note) {
        r.title = note.title;
        r.summary = typeof note.summary === 'object' ? note.summary.body : note.summary;
        r.tags = note.tags;
      }
    }

    return top;
  }

  // ── Internal ──────────────────────────────────────────

  _computeVector(tokens) {
    if (!this.vocab) return new Array(VOCAB_SIZE).fill(0);

    const tf = new Map();
    for (const t of tokens) {
      if (this.vocab.has(t)) {
        tf.set(t, (tf.get(t) || 0) + 1);
      }
    }

    const maxTf = Math.max(1, ...tf.values());
    const vec = new Array(this.vocab.size).fill(0);

    for (const [term, count] of tf.entries()) {
      const idx = this.vocab.get(term);
      const normalizedTf = 0.5 + 0.5 * (count / maxTf); // augmented TF
      const idfScore = this.idf?.get(term) || 1;
      vec[idx] = normalizedTf * idfScore;
    }

    return vec;
  }

  async _ensureVocab() {
    if (this.vocab) return;
    try {
      this.vocabList = await this.vocabSub.get('_vocab');
      this.vocab = new Map(this.vocabList.map((t, i) => [t, i]));
      const idfObj = await this.vocabSub.get('_idf');
      this.idf = new Map(Object.entries(idfObj));
    } catch {
      // No vocab built yet
      this.vocab = null;
    }
  }
}

// ── Math ────────────────────────────────────────────────

function magnitude(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  return Math.sqrt(sum);
}

function cosine(a, b, aMag) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let bSq = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    bSq += b[i] * b[i];
  }
  const bMag = Math.sqrt(bSq);
  if (aMag === 0 || bMag === 0) return 0;
  return dot / (aMag * bMag);
}
