/**
 * Wikipedia importer — crawls articles via the MediaWiki API,
 * stores summaries + [[wikilinks]] in Composia.
 *
 * Uses breadth-first crawl from seed topics.
 */

const API_URL = 'https://en.wikipedia.org/w/api.php';
const BATCH_SIZE = 50; // Max titles per API request
const DELAY_MS = 100;  // Be nice to Wikipedia

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function apiFetch(params) {
  const url = new URL(API_URL);
  params.format = 'json';
  params.origin = '*';
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Wikipedia API error: ${res.status}`);
  return res.json();
}

/**
 * Fetch summaries + links for a batch of titles.
 * Returns array of { title, slug, extract, links[] }
 */
async function fetchBatch(titles) {
  // Fetch extracts (summaries)
  const extractData = await apiFetch({
    action: 'query',
    titles: titles.join('|'),
    prop: 'extracts',
    exintro: '1',
    explaintext: '1',
    exlimit: String(BATCH_SIZE),
    redirects: '1',
  });

  // Fetch links
  const linkData = await apiFetch({
    action: 'query',
    titles: titles.join('|'),
    prop: 'links',
    pllimit: '500',
    plnamespace: '0', // Main namespace only
    redirects: '1',
  });

  const pages = extractData.query?.pages || {};
  const linkPages = linkData.query?.pages || {};

  const results = [];
  for (const [pageId, page] of Object.entries(pages)) {
    if (pageId === '-1' || page.missing !== undefined) continue;
    const title = page.title;
    const slug = slugify(title);
    const extract = page.extract || '';

    // Get links for this page
    const pageLinks = linkPages[pageId]?.links || [];
    const linkSlugs = pageLinks
      .map(l => l.title)
      .filter(t => !t.includes(':')) // Skip "Category:", "File:", etc.
      .map(t => slugify(t));

    results.push({ title, slug, extract, links: linkSlugs, linkTitles: pageLinks.map(l => l.title) });
  }

  return results;
}

/**
 * Get popular/important Wikipedia articles as seeds.
 */
async function getSeedTitles(count = 200) {
  // Use "vital articles" categories and popular pages
  const seeds = [
    // Sciences
    'Physics', 'Chemistry', 'Biology', 'Mathematics', 'Computer science',
    'Astronomy', 'Geology', 'Ecology', 'Genetics', 'Neuroscience',
    'Quantum mechanics', 'Theory of relativity', 'Evolution', 'DNA',
    'Artificial intelligence', 'Machine learning', 'Algorithm', 'Internet',
    // History
    'World War II', 'World War I', 'Ancient Rome', 'Ancient Greece',
    'Renaissance', 'Industrial Revolution', 'Cold War', 'French Revolution',
    'Roman Empire', 'British Empire', 'Ottoman Empire', 'Mongol Empire',
    // Geography
    'Earth', 'Africa', 'Asia', 'Europe', 'North America', 'South America',
    'Pacific Ocean', 'Atlantic Ocean', 'Sahara', 'Amazon rainforest',
    // People
    'Albert Einstein', 'Isaac Newton', 'Charles Darwin', 'Nikola Tesla',
    'Marie Curie', 'Leonardo da Vinci', 'Aristotle', 'Plato', 'Socrates',
    'William Shakespeare', 'Wolfgang Amadeus Mozart', 'Ludwig van Beethoven',
    'Napoleon', 'Alexander the Great', 'Julius Caesar', 'Cleopatra',
    'Mahatma Gandhi', 'Martin Luther King Jr.', 'Nelson Mandela',
    'Ada Lovelace', 'Alan Turing', 'Tim Berners-Lee',
    // Technology
    'Computer', 'Programming language', 'World Wide Web', 'Smartphone',
    'Transistor', 'Microprocessor', 'Operating system', 'Linux',
    'Python (programming language)', 'JavaScript', 'Rust (programming language)',
    'Database', 'Cryptography', 'Blockchain', 'Neural network',
    // Philosophy & Culture
    'Philosophy', 'Democracy', 'Human rights', 'United Nations',
    'Literature', 'Music', 'Art', 'Film', 'Architecture',
    'Religion', 'Science', 'Education', 'Language',
    // Nature
    'Sun', 'Moon', 'Mars', 'Jupiter', 'Solar System', 'Milky Way',
    'Climate change', 'Photosynthesis', 'Cell (biology)', 'Virus',
    'Dinosaur', 'Mammal', 'Bird', 'Ocean', 'Mountain',
    // Economics & Society
    'Economics', 'Capitalism', 'Globalization', 'United States',
    'China', 'India', 'Japan', 'Germany', 'France', 'United Kingdom',
    'Russia', 'Brazil', 'Australia', 'Canada', 'Mexico',
    'New York City', 'London', 'Tokyo', 'Paris', 'Berlin',
  ];

  // Also fetch links from top articles to discover more
  if (count > seeds.length) {
    const firstBatch = seeds.slice(0, BATCH_SIZE);
    const results = await fetchBatch(firstBatch);
    const discovered = new Set(seeds.map(s => s));
    for (const r of results) {
      for (const lt of r.linkTitles || []) {
        if (!discovered.has(lt) && !lt.includes(':')) {
          discovered.add(lt);
          seeds.push(lt);
          if (seeds.length >= count) break;
        }
      }
      if (seeds.length >= count) break;
    }
  }

  return seeds.slice(0, count);
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, '') // Remove parentheticals like "(programming language)"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'untitled';
}

/**
 * Import Wikipedia articles into Composia.
 *
 * @param {Knowledge} kb - Composia knowledge service
 * @param {object} opts
 * @param {number} opts.target - target number of articles (default 1000)
 * @param {function} opts.onProgress - callback(imported, total)
 * @returns {{ imported: number, links: number }}
 */
export async function importWikipedia(kb, { target = 1000, onProgress } = {}) {
  const seedTitles = await getSeedTitles(Math.min(target, 200));
  const queue = [...seedTitles];
  const visited = new Set();
  let imported = 0;
  let linkCount = 0;

  while (queue.length > 0 && imported < target) {
    // Take a batch
    const batch = [];
    while (batch.length < BATCH_SIZE && queue.length > 0 && imported + batch.length < target) {
      const title = queue.shift();
      if (visited.has(title)) continue;
      visited.add(title);
      batch.push(title);
    }

    if (batch.length === 0) break;

    try {
      const results = await fetchBatch(batch);

      for (const article of results) {
        // Build markdown content with wikilinks
        const lines = [`# ${article.title}`, ''];

        if (article.extract) {
          lines.push(article.extract);
          lines.push('');
        }

        // Add links as wikilinks
        if (article.links.length > 0) {
          lines.push('## Related');
          const displayLinks = article.links.slice(0, 30); // Cap links per article
          lines.push(displayLinks.map(l => `[[${l}]]`).join(' | '));
          lines.push('');
        }

        const content = lines.join('\n');
        await kb.saveNote({
          id: article.slug,
          title: article.title,
          content,
          tags: ['wikipedia'],
        });

        imported++;
        linkCount += Math.min(article.links.length, 30);

        // Add discovered links to the queue for crawling
        for (const linkTitle of (article.linkTitles || []).slice(0, 20)) {
          if (!visited.has(linkTitle) && !linkTitle.includes(':')) {
            queue.push(linkTitle);
          }
        }
      }

      if (onProgress) onProgress(imported, target);
    } catch (err) {
      console.error(`Batch failed: ${err.message}`);
      // Continue with next batch
    }

    await sleep(DELAY_MS);
  }

  return { imported, links: linkCount };
}
