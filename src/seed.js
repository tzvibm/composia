/**
 * Seed the database with a rich demo knowledge graph.
 * Creates ~200 notes with ~800 cross-links across topics.
 */

const TOPICS = {
  'computer-science': {
    children: ['algorithms', 'data-structures', 'programming-languages', 'operating-systems', 'databases', 'networking', 'cryptography', 'machine-learning', 'distributed-systems', 'compilers'],
    tags: ['cs'],
  },
  'algorithms': {
    children: ['sorting-algorithms', 'graph-algorithms', 'dynamic-programming', 'greedy-algorithms', 'divide-and-conquer', 'backtracking', 'binary-search', 'hashing'],
    tags: ['cs', 'algorithms'],
  },
  'sorting-algorithms': {
    children: ['quicksort', 'mergesort', 'heapsort', 'radix-sort', 'insertion-sort', 'bubble-sort'],
    tags: ['cs', 'algorithms', 'sorting'],
  },
  'quicksort': { children: ['divide-and-conquer', 'recursion'], tags: ['algorithms', 'sorting'] },
  'mergesort': { children: ['divide-and-conquer', 'recursion'], tags: ['algorithms', 'sorting'] },
  'heapsort': { children: ['binary-heap', 'priority-queue'], tags: ['algorithms', 'sorting'] },
  'radix-sort': { children: ['counting-sort'], tags: ['algorithms', 'sorting'] },
  'insertion-sort': { children: [], tags: ['algorithms', 'sorting'] },
  'bubble-sort': { children: [], tags: ['algorithms', 'sorting'] },
  'counting-sort': { children: [], tags: ['algorithms', 'sorting'] },
  'graph-algorithms': {
    children: ['breadth-first-search', 'depth-first-search', 'dijkstra', 'a-star', 'bellman-ford', 'minimum-spanning-tree', 'topological-sort'],
    tags: ['cs', 'algorithms', 'graphs'],
  },
  'breadth-first-search': { children: ['queue', 'graph-theory'], tags: ['algorithms', 'graphs'] },
  'depth-first-search': { children: ['stack', 'recursion', 'graph-theory'], tags: ['algorithms', 'graphs'] },
  'dijkstra': { children: ['priority-queue', 'greedy-algorithms', 'graph-theory'], tags: ['algorithms', 'graphs'] },
  'a-star': { children: ['dijkstra', 'heuristics'], tags: ['algorithms', 'graphs', 'ai'] },
  'bellman-ford': { children: ['dynamic-programming', 'graph-theory'], tags: ['algorithms', 'graphs'] },
  'minimum-spanning-tree': { children: ['graph-theory', 'greedy-algorithms'], tags: ['algorithms', 'graphs'] },
  'topological-sort': { children: ['depth-first-search', 'directed-acyclic-graph'], tags: ['algorithms', 'graphs'] },
  'dynamic-programming': { children: ['memoization', 'recursion', 'optimization'], tags: ['algorithms'] },
  'greedy-algorithms': { children: ['optimization'], tags: ['algorithms'] },
  'divide-and-conquer': { children: ['recursion'], tags: ['algorithms'] },
  'backtracking': { children: ['recursion', 'constraint-satisfaction'], tags: ['algorithms'] },
  'binary-search': { children: ['sorted-array', 'logarithmic-time'], tags: ['algorithms'] },
  'hashing': { children: ['hash-table', 'collision-resolution', 'cryptographic-hash'], tags: ['algorithms'] },
  'data-structures': {
    children: ['array', 'linked-list', 'stack', 'queue', 'hash-table', 'binary-tree', 'binary-heap', 'graph-theory', 'trie', 'bloom-filter'],
    tags: ['cs', 'data-structures'],
  },
  'array': { children: ['sorted-array', 'dynamic-array'], tags: ['data-structures'] },
  'linked-list': { children: ['doubly-linked-list', 'circular-list'], tags: ['data-structures'] },
  'stack': { children: ['lifo'], tags: ['data-structures'] },
  'queue': { children: ['priority-queue', 'fifo'], tags: ['data-structures'] },
  'hash-table': { children: ['hashing', 'collision-resolution'], tags: ['data-structures'] },
  'binary-tree': { children: ['binary-search-tree', 'avl-tree', 'red-black-tree', 'b-tree'], tags: ['data-structures', 'trees'] },
  'binary-search-tree': { children: ['binary-search', 'tree-traversal'], tags: ['data-structures', 'trees'] },
  'avl-tree': { children: ['binary-search-tree', 'self-balancing'], tags: ['data-structures', 'trees'] },
  'red-black-tree': { children: ['binary-search-tree', 'self-balancing'], tags: ['data-structures', 'trees'] },
  'b-tree': { children: ['databases', 'disk-storage'], tags: ['data-structures', 'trees'] },
  'binary-heap': { children: ['priority-queue', 'binary-tree'], tags: ['data-structures'] },
  'graph-theory': { children: ['directed-acyclic-graph', 'adjacency-matrix', 'adjacency-list'], tags: ['data-structures', 'math'] },
  'trie': { children: ['prefix-tree', 'autocomplete'], tags: ['data-structures'] },
  'bloom-filter': { children: ['hashing', 'probabilistic'], tags: ['data-structures'] },
  'priority-queue': { children: ['binary-heap'], tags: ['data-structures'] },
  'programming-languages': {
    children: ['javascript', 'python', 'rust', 'go', 'c', 'cpp', 'java', 'typescript', 'haskell', 'lisp'],
    tags: ['cs', 'languages'],
  },
  'javascript': { children: ['nodejs', 'v8-engine', 'event-loop', 'prototype-chain', 'closures'], tags: ['languages', 'web'] },
  'python': { children: ['cpython', 'gil', 'decorators', 'generators', 'list-comprehension'], tags: ['languages'] },
  'rust': { children: ['ownership', 'borrowing', 'lifetimes', 'zero-cost-abstractions', 'cargo'], tags: ['languages', 'systems'] },
  'go': { children: ['goroutines', 'channels', 'interfaces'], tags: ['languages'] },
  'c': { children: ['pointers', 'memory-management', 'preprocessor'], tags: ['languages', 'systems'] },
  'cpp': { children: ['c', 'templates', 'raii', 'stl'], tags: ['languages', 'systems'] },
  'java': { children: ['jvm', 'garbage-collection', 'interfaces'], tags: ['languages'] },
  'typescript': { children: ['javascript', 'type-system', 'generics'], tags: ['languages', 'web'] },
  'haskell': { children: ['monads', 'type-classes', 'lazy-evaluation', 'functional-programming'], tags: ['languages', 'functional'] },
  'lisp': { children: ['s-expressions', 'macros', 'functional-programming'], tags: ['languages', 'functional'] },
  'operating-systems': {
    children: ['process-management', 'memory-management', 'file-systems', 'concurrency', 'linux-kernel', 'virtual-memory', 'scheduling'],
    tags: ['cs', 'os'],
  },
  'process-management': { children: ['threads', 'inter-process-communication', 'scheduling'], tags: ['os'] },
  'memory-management': { children: ['virtual-memory', 'paging', 'garbage-collection', 'malloc'], tags: ['os'] },
  'file-systems': { children: ['ext4', 'btree-filesystem', 'journaling'], tags: ['os'] },
  'concurrency': { children: ['threads', 'mutex', 'semaphore', 'deadlock', 'race-condition'], tags: ['os', 'parallel'] },
  'databases': {
    children: ['relational-databases', 'nosql', 'key-value-stores', 'graph-databases', 'sql', 'acid', 'cap-theorem', 'indexing'],
    tags: ['cs', 'databases'],
  },
  'relational-databases': { children: ['sql', 'normalization', 'joins', 'postgresql', 'mysql'], tags: ['databases'] },
  'nosql': { children: ['mongodb', 'redis', 'cassandra', 'key-value-stores', 'document-stores'], tags: ['databases'] },
  'key-value-stores': { children: ['redis', 'rocksdb', 'lmdb', 'leveldb'], tags: ['databases'] },
  'rocksdb': { children: ['lsm-tree', 'compaction', 'leveldb'], tags: ['databases', 'storage'] },
  'lmdb': { children: ['memory-mapped-io', 'b-tree', 'acid'], tags: ['databases', 'storage'] },
  'leveldb': { children: ['lsm-tree', 'key-value-stores'], tags: ['databases', 'storage'] },
  'graph-databases': { children: ['neo4j', 'graph-theory', 'cypher-query'], tags: ['databases', 'graphs'] },
  'sql': { children: ['joins', 'indexing', 'query-optimization'], tags: ['databases'] },
  'acid': { children: ['transactions', 'isolation-levels'], tags: ['databases'] },
  'cap-theorem': { children: ['consistency', 'availability', 'partition-tolerance'], tags: ['databases', 'distributed'] },
  'indexing': { children: ['b-tree', 'hash-index', 'inverted-index'], tags: ['databases'] },
  'networking': {
    children: ['tcp-ip', 'http', 'dns', 'tls', 'websockets', 'rest-api', 'grpc', 'load-balancing'],
    tags: ['cs', 'networking'],
  },
  'tcp-ip': { children: ['osi-model', 'three-way-handshake', 'congestion-control'], tags: ['networking'] },
  'http': { children: ['rest-api', 'http2', 'http3', 'status-codes'], tags: ['networking', 'web'] },
  'dns': { children: ['domain-resolution', 'caching'], tags: ['networking'] },
  'tls': { children: ['cryptography', 'certificates', 'handshake'], tags: ['networking', 'security'] },
  'websockets': { children: ['real-time', 'event-loop'], tags: ['networking', 'web'] },
  'rest-api': { children: ['http', 'json', 'crud'], tags: ['networking', 'web'] },
  'cryptography': {
    children: ['symmetric-encryption', 'asymmetric-encryption', 'digital-signatures', 'cryptographic-hash', 'zero-knowledge-proofs'],
    tags: ['cs', 'security'],
  },
  'symmetric-encryption': { children: ['aes', 'des', 'block-cipher'], tags: ['security'] },
  'asymmetric-encryption': { children: ['rsa', 'elliptic-curves', 'diffie-hellman'], tags: ['security'] },
  'digital-signatures': { children: ['asymmetric-encryption', 'authentication'], tags: ['security'] },
  'cryptographic-hash': { children: ['sha-256', 'md5', 'merkle-tree'], tags: ['security'] },
  'machine-learning': {
    children: ['neural-networks', 'supervised-learning', 'unsupervised-learning', 'reinforcement-learning', 'deep-learning', 'natural-language-processing', 'computer-vision', 'gradient-descent'],
    tags: ['cs', 'ai', 'ml'],
  },
  'neural-networks': { children: ['backpropagation', 'activation-functions', 'deep-learning', 'transformers'], tags: ['ai', 'ml'] },
  'deep-learning': { children: ['convolutional-networks', 'recurrent-networks', 'transformers', 'generative-models'], tags: ['ai', 'ml'] },
  'transformers': { children: ['attention-mechanism', 'bert', 'gpt', 'self-attention'], tags: ['ai', 'ml', 'nlp'] },
  'attention-mechanism': { children: ['self-attention', 'multi-head-attention'], tags: ['ai', 'ml'] },
  'gpt': { children: ['transformers', 'language-models', 'autoregressive'], tags: ['ai', 'ml', 'nlp'] },
  'bert': { children: ['transformers', 'language-models', 'masked-language-model'], tags: ['ai', 'ml', 'nlp'] },
  'natural-language-processing': { children: ['tokenization', 'embeddings', 'transformers', 'sentiment-analysis'], tags: ['ai', 'nlp'] },
  'computer-vision': { children: ['convolutional-networks', 'object-detection', 'image-segmentation'], tags: ['ai', 'ml'] },
  'gradient-descent': { children: ['learning-rate', 'stochastic-gradient-descent', 'optimization'], tags: ['ml', 'math'] },
  'reinforcement-learning': { children: ['q-learning', 'policy-gradient', 'markov-decision-process'], tags: ['ai', 'ml'] },
  'distributed-systems': {
    children: ['consensus', 'replication', 'sharding', 'microservices', 'message-queues', 'eventual-consistency'],
    tags: ['cs', 'distributed'],
  },
  'consensus': { children: ['raft', 'paxos', 'byzantine-fault-tolerance'], tags: ['distributed'] },
  'replication': { children: ['leader-follower', 'multi-leader', 'leaderless'], tags: ['distributed'] },
  'microservices': { children: ['service-mesh', 'api-gateway', 'docker', 'kubernetes'], tags: ['distributed', 'architecture'] },
  'docker': { children: ['containers', 'images', 'dockerfile'], tags: ['devops'] },
  'kubernetes': { children: ['docker', 'orchestration', 'pods', 'services'], tags: ['devops', 'distributed'] },
  'compilers': {
    children: ['lexical-analysis', 'parsing', 'abstract-syntax-tree', 'code-generation', 'optimization', 'type-checking'],
    tags: ['cs', 'compilers'],
  },
  'lexical-analysis': { children: ['tokenization', 'regular-expressions'], tags: ['compilers'] },
  'parsing': { children: ['context-free-grammar', 'abstract-syntax-tree', 'recursive-descent'], tags: ['compilers'] },
  'abstract-syntax-tree': { children: ['parsing', 'tree-traversal'], tags: ['compilers'] },
  'mathematics': {
    children: ['linear-algebra', 'calculus', 'probability', 'statistics', 'discrete-math', 'number-theory', 'category-theory', 'topology'],
    tags: ['math'],
  },
  'linear-algebra': { children: ['matrices', 'vectors', 'eigenvalues', 'singular-value-decomposition'], tags: ['math', 'ml'] },
  'calculus': { children: ['derivatives', 'integrals', 'limits', 'differential-equations'], tags: ['math'] },
  'probability': { children: ['bayes-theorem', 'distributions', 'expected-value', 'markov-chains'], tags: ['math', 'ml'] },
  'statistics': { children: ['hypothesis-testing', 'regression', 'bayesian-statistics'], tags: ['math', 'ml'] },
  'discrete-math': { children: ['combinatorics', 'graph-theory', 'logic', 'set-theory'], tags: ['math', 'cs'] },
  'number-theory': { children: ['prime-numbers', 'modular-arithmetic', 'cryptography'], tags: ['math'] },
  'philosophy': {
    children: ['epistemology', 'ethics', 'metaphysics', 'logic', 'philosophy-of-mind', 'existentialism'],
    tags: ['philosophy'],
  },
  'epistemology': { children: ['knowledge', 'justification', 'skepticism', 'empiricism', 'rationalism'], tags: ['philosophy'] },
  'ethics': { children: ['utilitarianism', 'deontology', 'virtue-ethics', 'ai-ethics'], tags: ['philosophy'] },
  'ai-ethics': { children: ['machine-learning', 'bias', 'fairness', 'transparency'], tags: ['philosophy', 'ai'] },
  'physics': {
    children: ['quantum-mechanics', 'relativity', 'thermodynamics', 'electromagnetism', 'particle-physics'],
    tags: ['physics', 'science'],
  },
  'quantum-mechanics': { children: ['superposition', 'entanglement', 'wave-function', 'quantum-computing'], tags: ['physics'] },
  'quantum-computing': { children: ['qubits', 'quantum-gates', 'quantum-algorithms', 'cryptography'], tags: ['physics', 'cs'] },
  'relativity': { children: ['spacetime', 'general-relativity', 'special-relativity'], tags: ['physics'] },
  'thermodynamics': { children: ['entropy', 'energy', 'heat-transfer'], tags: ['physics'] },
};

function titleCase(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export async function seedDatabase(kb) {
  const allIds = new Set(Object.keys(TOPICS));
  // Also collect all referenced children
  for (const entry of Object.values(TOPICS)) {
    for (const child of entry.children) {
      allIds.add(child);
    }
  }

  let noteCount = 0;
  let linkCount = 0;

  for (const id of allIds) {
    const entry = TOPICS[id];
    const children = entry?.children || [];
    const tags = entry?.tags || [];

    // Build markdown content with wikilinks
    const lines = [`# ${titleCase(id)}`, ''];
    if (children.length > 0) {
      lines.push(`${titleCase(id)} connects to several important concepts:`);
      lines.push('');
      for (const child of children) {
        lines.push(`- [[${child}]] - ${titleCase(child)} is a key related topic`);
      }
      lines.push('');
    }
    // Add some cross-links to random other topics for richness
    const otherIds = [...allIds].filter(x => x !== id && !children.includes(x));
    const crossLinks = otherIds.sort(() => Math.random() - 0.5).slice(0, 2);
    if (crossLinks.length) {
      lines.push(`See also: ${crossLinks.map(c => `[[${c}]]`).join(', ')}`);
      lines.push('');
    }
    if (tags.length) {
      lines.push(tags.map(t => `#${t}`).join(' '));
    }

    const content = lines.join('\n');
    await kb.saveNote({ id, title: titleCase(id), content, tags });
    noteCount++;
    linkCount += children.length + crossLinks.length;
  }

  return { notes: noteCount, links: linkCount };
}
