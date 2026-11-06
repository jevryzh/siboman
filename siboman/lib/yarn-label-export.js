import { PDFDocument } from "pdf-lib";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function buildOrderedYarnLabels(postings, options) {
  const { baseUrl, clientId, apiKey, fetchImpl = fetch, onProgress = () => {}, sleep = pause } = options;
  const slots = new Array(postings.length);
  let cursor = 0;
  let completed = 0;
  let rateLimited = 0;
  let firstFailure = null;
  let requested = false;
  const requestInterval = 2000;

  const fetchOne = async (posting) => {
    // Codex: one request per posting; 429 and timeouts must stop this export, not retry indefinitely.
    if (requested) await sleep(requestInterval);
    requested = true;
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/v2/posting/fbs/package-label`, {
        method: "POST",
        headers: { "Client-Id": clientId, "Api-Key": apiKey, "Content-Type": "application/json", Accept: "application/pdf, application/json" },
        body: JSON.stringify({ posting_number: [posting] }),
        signal: AbortSignal.timeout(45000),
      });
    } catch (error) {
      throw new Error(`请求失败或超时：${String(error.message || error).slice(0, 160)}`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";
    if (response.ok && !contentType.includes("json") && body.subarray(0, 4).toString() === "%PDF") return body;
    if (response.status === 429) {
      rateLimited += 1;
      onProgress({ completed, total: postings.length, rateLimited });
    }
    throw new Error(`HTTP ${response.status}: ${body.toString("utf8").slice(0, 160)}`);
  };

  const worker = async () => {
    while (!firstFailure && cursor < postings.length) {
      const index = cursor++;
      try { slots[index] = await fetchOne(postings[index]); }
      catch (error) { firstFailure ||= { posting: postings[index], error }; }
      completed += 1;
      onProgress({ completed, total: postings.length, rateLimited });
    }
  };
  await worker();
  if (firstFailure) throw new Error(`货件 ${firstFailure.posting} 获取标签失败：${firstFailure.error.message}。没有生成不完整的 PDF。`);

  const output = await PDFDocument.create();
  for (const buffer of slots) {
    const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pages = await output.copyPages(source, source.getPageIndices());
    pages.forEach((page) => output.addPage(page));
  }
  return Buffer.from(await output.save());
}
