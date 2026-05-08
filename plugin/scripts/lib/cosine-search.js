/**
 * Local cosine-similarity helpers for Phase 7 Memory Layer semantic recall
 * (VP-1308). Pure JS, zero deps. Vectors are stored as BLOBs holding
 * Float32 little-endian payloads on the local `session_digests` table.
 *
 * Why brute-force JS, not pgvector / a dedicated index?
 *  - We expect O(100s) of session digests per developer per project.
 *  - 768 floats × 100 rows × 1 cosine = ~10ms in plain Node.
 *  - Anything bigger is a future Phase 7b problem; today, simple wins.
 *
 * Per dec-RQtOzDnr (Phase 7 architecture): zero new deps, zero added LLM
 * cost, brute-force JS cosine, vectors cached as BLOB on existing rows.
 */

/**
 * Read a Float32Array view over a Buffer holding LE Float32 payloads.
 * Returns null if the buffer length isn't a multiple of 4 bytes.
 *
 * Note: we don't copy — we just view the underlying ArrayBuffer slice.
 */
function asFloat32(buf) {
  if (!buf || !Buffer.isBuffer(buf)) return null;
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 for:
 *  - either vector zero-magnitude (avoids NaN)
 *  - mismatched dimensions
 *  - non-Buffer input
 *
 * @param {Buffer} vecA - LE Float32 payload
 * @param {Buffer} vecB - LE Float32 payload
 * @returns {number}
 */
export function cosineSimilarity(vecA, vecB) {
  const a = asFloat32(vecA);
  const b = asFloat32(vecB);
  if (!a || !b) return 0;
  if (a.length !== b.length) return 0;

  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Rank candidates by cosine similarity to the query vector and return
 * the top K. Stable sort (preserves insertion order on ties).
 *
 * @param {Buffer} query
 * @param {Array<{id: string, embedding: Buffer}>} candidates
 * @param {number} k
 * @returns {Array<{id: string, score: number}>}
 */
export function topKByCosine(query, candidates, k) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const limit = Math.min(k | 0, candidates.length);
  if (limit <= 0) return [];

  // Score everything once, attach original index for stable tiebreak.
  const scored = candidates.map((c, idx) => ({
    id: c.id,
    score: cosineSimilarity(query, c.embedding),
    _idx: idx,
  }));

  // Sort descending by score, ascending by original index on ties.
  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    return x._idx - y._idx;
  });

  return scored.slice(0, limit).map(({ id, score }) => ({ id, score }));
}
