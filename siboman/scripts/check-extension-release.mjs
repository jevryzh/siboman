import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const EXTENSION_DIR = path.join(root, "public/extension/zhumeng-collector");
const ZIP_PATH = path.join(root, "public/extension/zhumeng-collector.zip");
const STORE_VIEW_PATH = path.join(root, "public/js/views/StoreManagement.js");
const TEST_ORIGIN = "https://test.renwz.cn";
const DOWNLOAD_PATH = "/extension/zhumeng-collector.zip";
const PUBLIC_MANIFEST_PATH = "/extension/zhumeng-collector/manifest.json";

const quiet = process.argv.includes("--quiet");
const shouldCheckRemote = process.argv.includes("--remote-test") || process.env.CHECK_REMOTE_TEST === "1";
const failures = [];
const warnings = [];

function fail(message) { failures.push(message); }
function warn(message) { warnings.push(message); }
function readText(filePath) { return fs.readFileSync(filePath, "utf8"); }
function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function normalizeSlash(value) { return value.split(path.sep).join("/"); }

function matchVersion(content, pattern, label) {
  const match = content.match(pattern);
  if (!match) fail(`missing ${label}`);
  return match?.[1] || "";
}

function listSourceFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listSourceFiles(fullPath));
    else if (entry.isFile()) result.push(normalizeSlash(path.relative(EXTENSION_DIR, fullPath)));
  }
  return result.sort();
}

async function fetchJson(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  if (!fs.existsSync(EXTENSION_DIR)) fail(`missing extension directory: ${EXTENSION_DIR}`);
  if (!fs.existsSync(ZIP_PATH)) fail(`missing extension zip: ${ZIP_PATH}`);
  if (!fs.existsSync(STORE_VIEW_PATH)) fail(`missing store management view: ${STORE_VIEW_PATH}`);
  if (failures.length) return finish();

  const manifestPath = path.join(EXTENSION_DIR, "manifest.json");
  const backgroundPath = path.join(EXTENSION_DIR, "background.js");
  const popupPath = path.join(EXTENSION_DIR, "popup.js");
  const bridgePath = path.join(EXTENSION_DIR, "content-bridge-iso.js");

  const manifest = JSON.parse(readText(manifestPath));
  const background = readText(backgroundPath);
  const storeView = readText(STORE_VIEW_PATH);
  const popup = readText(popupPath);
  const bridge = fs.existsSync(bridgePath) ? readText(bridgePath) : "";

  const manifestVersion = String(manifest.version || "");
  const backgroundVersion = matchVersion(background, /\bconst\s+VERSION\s*=\s*["']([^"']+)["']/, "background VERSION");
  const manifestUiVersion = matchVersion(storeView, /PLUGIN_MANIFEST_VERSION\s*=\s*['"]([^'"]+)/, "StoreManagement PLUGIN_MANIFEST_VERSION");
  const zipUiVersion = matchVersion(storeView, /PLUGIN_ZIP_VERSION\s*=\s*['"]([^'"]+)/, "StoreManagement PLUGIN_ZIP_VERSION");
  const bridgeVersion = bridge.match(/\bconst\s+VERSION\s*=\s*["']([^"']+)["']/)?.[1] || "";

  if (!manifestVersion) fail("manifest.json is missing version");
  if (backgroundVersion !== manifestVersion) fail(`background VERSION ${backgroundVersion || "(missing)"} does not match manifest ${manifestVersion}`);
  if (manifestUiVersion !== manifestVersion) fail(`StoreManagement manifest UI version ${manifestUiVersion || "(missing)"} does not match manifest ${manifestVersion}`);
  if (zipUiVersion !== manifestVersion) fail(`StoreManagement zip UI version ${zipUiVersion || "(missing)"} does not match manifest ${manifestVersion}`);
  if (!storeView.includes("PLUGIN_MANIFEST_VERSION")) fail("StoreManagement must expose PLUGIN_MANIFEST_VERSION");
  if (!storeView.includes("PLUGIN_ZIP_VERSION")) fail("StoreManagement must expose PLUGIN_ZIP_VERSION");
  if (!storeView.includes(`${DOWNLOAD_PATH}?v=${"${PLUGIN_ZIP_VERSION}"}`) && !storeView.includes(`${DOWNLOAD_PATH}?v=${manifestVersion}`)) {
    fail(`StoreManagement must download ${DOWNLOAD_PATH}?v=<PLUGIN_ZIP_VERSION>`);
  }
  if (!storeView.includes(`v${manifestVersion} 修复`) && !storeView.includes(`v${manifestVersion} `)) {
    fail(`StoreManagement changelog does not include v${manifestVersion}`);
  }
  if (!popup.includes("chrome.runtime.getManifest()")) fail("popup.js must read chrome.runtime.getManifest() so popup UI follows manifest version");
  if (bridgeVersion && bridgeVersion !== manifestVersion) {
    fail(`content bridge diagnostic version ${bridgeVersion} does not match manifest ${manifestVersion}`);
  }

  const zipEntries = getZipEntriesFromBuffer(fs.readFileSync(ZIP_PATH));
  const sourceFiles = listSourceFiles(EXTENSION_DIR);
  const zipFiles = Array.from(zipEntries.keys()).sort();
  const sourceSet = new Set(sourceFiles);
  const zipSet = new Set(zipFiles);

  for (const file of sourceFiles) if (!zipSet.has(file)) fail(`zip is missing ${file}`);
  for (const file of zipFiles) if (!sourceSet.has(file)) fail(`zip contains unexpected ${file}`);
  for (const file of sourceFiles) {
    const zipBuffer = zipEntries.get(file);
    if (!zipBuffer) continue;
    const sourceBuffer = fs.readFileSync(path.join(EXTENSION_DIR, file));
    if (sha256(sourceBuffer) !== sha256(zipBuffer)) fail(`zip content differs from source for ${file}`);
  }

  const zipManifestBuffer = zipEntries.get("manifest.json");
  if (zipManifestBuffer) {
    const zipManifest = JSON.parse(zipManifestBuffer.toString("utf8"));
    if (String(zipManifest.version || "") !== manifestVersion) fail(`zip manifest version ${zipManifest.version || "(missing)"} does not match source manifest ${manifestVersion}`);
  }
  const zipBackgroundBuffer = zipEntries.get("background.js");
  if (zipBackgroundBuffer) {
    const zipBackgroundVersion = zipBackgroundBuffer.toString("utf8").match(/\bconst\s+VERSION\s*=\s*["']([^"']+)["']/)?.[1] || "";
    if (zipBackgroundVersion !== manifestVersion) fail(`zip background VERSION ${zipBackgroundVersion || "(missing)"} does not match manifest ${manifestVersion}`);
  }

  for (const requiredHost of ["https://test.renwz.cn/*", "http://test.renwz.cn/*"]) {
    if (!JSON.stringify(manifest).includes(requiredHost)) fail(`manifest host permissions missing ${requiredHost}`);
  }

  const expectedDownloadUrl = `${TEST_ORIGIN}${DOWNLOAD_PATH}?v=${manifestVersion}`;
  const expectedManifestUrl = `${TEST_ORIGIN}${PUBLIC_MANIFEST_PATH}`;
  if (shouldCheckRemote) {
    const remoteManifest = await fetchJson(expectedManifestUrl);
    if (String(remoteManifest.version || "") !== manifestVersion) fail(`test env manifest is ${remoteManifest.version || "(missing)"}, expected ${manifestVersion}`);
    const remoteZipEntries = getZipEntriesFromBuffer(await fetchBytes(expectedDownloadUrl));
    const remoteZipManifest = JSON.parse((remoteZipEntries.get("manifest.json") || Buffer.alloc(0)).toString("utf8"));
    if (String(remoteZipManifest.version || "") !== manifestVersion) fail(`test env zip manifest is ${remoteZipManifest.version || "(missing)"}, expected ${manifestVersion}`);
  }

  finish({ manifestVersion, backgroundVersion, bridgeVersion, downloadUrl: expectedDownloadUrl, publicManifestUrl: expectedManifestUrl, fileCount: sourceFiles.length });
}

function getZipEntriesFromBuffer(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error("invalid zip: end of central directory not found");
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  let offset = centralDirectoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`invalid zip: central directory entry ${i} is corrupt`);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength);
    if (!fileName.endsWith("/") && !fileName.includes("__MACOSX/") && !fileName.endsWith(".DS_Store")) {
      if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error(`invalid zip: local header missing for ${fileName}`);
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
      let data;
      if (compressionMethod === 0) data = Buffer.from(compressed);
      else if (compressionMethod === 8) data = zlib.inflateRawSync(compressed);
      else throw new Error(`unsupported zip compression method ${compressionMethod} for ${fileName}`);
      entries.set(fileName, data);
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return new Map([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function finish(summary = {}) {
  if (!quiet) {
    console.log("Extension release consistency check");
    if (summary.manifestVersion) {
      console.log(`manifest/background version: ${summary.manifestVersion}`);
      console.log(`bridge diagnostic version: ${summary.bridgeVersion || "(missing)"}`);
      console.log(`source/zip file count: ${summary.fileCount}`);
      console.log(`test download URL: ${summary.downloadUrl}`);
      console.log(`test public manifest URL: ${summary.publicManifestUrl}`);
    }
    for (const message of warnings) console.warn(`WARN: ${message}`);
    for (const message of failures) console.error(`FAIL: ${message}`);
  }
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(`FAIL: ${error.stack || error.message || String(error)}`);
  process.exit(1);
});
