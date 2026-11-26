import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [metadataFile, assetDir, mode, batchNumber] = process.argv.slice(2);
const { GITCODE_REPO: repo, GITCODE_TOKEN: token } = process.env;
const smallAssetLimit = 1024 * 1024;
const largeUploadTimeout = 90 * 60_000;
const smallUploadTimeout = 3 * 60_000;
const verifyTimeout = 15 * 60_000;
const largeAssetsPerBatch = 3;

function require(condition, message) {
  if (!condition) throw new Error(message);
}

async function sha256(stream) {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function request(url, label, options = {}) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(30_000), ...options });
  } catch (error) {
    throw new Error(`${label} failed (${error.cause?.code ?? error.name})`);
  }
}

async function api(endpoint, method = "GET", payload, allowMissing = false) {
  const response = await request(
    `https://api.gitcode.com/api/v5/repos/${repo}${endpoint}`,
    `GitCode ${method} ${endpoint}`,
    {
      method,
      redirect: "error",
      headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    },
  );
  if (allowMissing && response.status === 404) return null;
  require(response.ok, `GitCode ${method} ${endpoint} returned HTTP ${response.status}`);
  return response.json();
}

function ensureTag(tag) {
  const ref = `refs/tags/${tag}`;
  const commit = execFileSync("git", ["rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  const remote = `https://gitcode.com/${repo}.git`;
  const remoteCommit = () => {
    const refs = new Map(
      execFileSync("git", ["ls-remote", remote, ref, `${ref}^{}`], { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t").reverse()),
    );
    return refs.get(`${ref}^{}`) ?? refs.get(ref);
  };

  if (!remoteCommit()) {
    const credentials = Buffer.from(`${repo.split("/")[0]}:${token}`).toString("base64");
    if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${credentials}`);
    execFileSync("git", ["push", remote, `${ref}:${ref}`], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://gitcode.com/.extraheader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`,
      },
      stdio: "inherit",
    });
  }
  require(remoteCommit() === commit, `GitCode tag ${tag} does not match GitHub commit ${commit}`);
  return commit;
}

async function inspectAssets(assets) {
  require(Array.isArray(assets) && assets.length > 0, "GitHub Release must include assets");
  const files = new Map();
  for (const asset of assets) {
    const { name, size, digest } = asset;
    require(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name), "Unsafe GitHub Release asset name");
    require(!files.has(name), `Duplicate GitHub Release asset ${name}`);
    const file = path.join(assetDir, name);
    const info = await stat(file);
    require(info.isFile() && info.size === size && size > 0, `Invalid local size for ${name}`);
    const hash = await sha256(createReadStream(file));
    require(!digest || digest === hash, `GitHub SHA-256 mismatch for ${name}`);
    files.set(name, { file, size, hash });
  }
  return files;
}

function attachments(release) {
  return new Map(
    release.assets.filter((asset) => asset.type === "attach").map((asset) => [asset.name, asset]),
  );
}

async function publicDigest(tag, name, timeout = verifyTimeout) {
  const url = `https://gitcode.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const response = await request(url, `Anonymous download of ${name}`, {
    signal: AbortSignal.timeout(timeout),
  });
  require(response.ok &&
    response.body, `Anonymous download of ${name} returned HTTP ${response.status}`);
  return sha256(response.body);
}

async function verifyAsset(tag, name, file, asset) {
  require(asset.size == null ||
    Number(asset.size) === file.size, `GitCode size mismatch for ${name}`);
  const hash = asset.digest || (await publicDigest(tag, name));
  require(hash === file.hash, `GitCode SHA-256 mismatch for ${name}`);
}

async function upload(tag, name, file) {
  const started = Date.now();
  console.log(`Uploading ${name} (${file.size} bytes)`);
  const { url, headers } = await api(
    `/releases/${tag}/upload_url?file_name=${encodeURIComponent(name)}`,
  );
  const destination = new URL(url);
  require(destination.protocol === "https:" &&
    !destination.username &&
    !destination.password, `Invalid GitCode upload destination for ${name}`);
  const timeout = file.size <= smallAssetLimit ? smallUploadTimeout : largeUploadTimeout;
  let bytesRead = 0;
  let lastReported = 0;
  async function* streamFile() {
    for await (const chunk of createReadStream(file.file)) {
      yield chunk;
      bytesRead += chunk.length;
      if (bytesRead - lastReported >= 32 * 1024 * 1024) {
        lastReported = bytesRead;
        console.log(`Read for upload: ${name} ${bytesRead}/${file.size} bytes`);
      }
    }
  }
  const response = await request(destination, `Upload of ${name}`, {
    method: "PUT",
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
    headers: { ...headers, "Content-Length": String(file.size) },
    body: streamFile(),
    duplex: "half",
  });
  require(response.ok, `Upload of ${name} returned HTTP ${response.status}`);
  await response.body?.cancel();
  console.log(`Uploaded ${name} in ${Math.ceil((Date.now() - started) / 1000)} seconds`);
}

function batchAssets(assets, number) {
  require(Number.isInteger(number) && number >= 0, "Expected a non-negative batch number");
  if (number === 0) return assets.filter(({ size }) => size <= smallAssetLimit);
  const large = assets
    .filter(({ size }) => size > smallAssetLimit)
    .toSorted((a, b) => b.size - a.size);
  return large.slice((number - 1) * largeAssetsPerBatch, number * largeAssetsPerBatch);
}

async function verifyRelease(release, releasePath) {
  const current = attachments(await api(releasePath));
  const missing = release.assets.filter(({ name }) => !current.has(name));
  console.log(
    `GitCode has ${release.assets.length - missing.length} of ${release.assets.length} GitHub attachments`,
  );
  for (const { name, size, digest: hash } of release.assets) {
    if (!current.has(name)) continue;
    require(hash, `GitHub has no SHA-256 digest for ${name}`);
    await verifyAsset(release.tagName, name, { size, hash }, current.get(name));
  }
  require(!missing.length, `Missing attachments: ${missing.map(({ name }) => name).join(", ")}`);
  const { name, digest, size } = release.assets.reduce((largest, asset) =>
    asset.size > largest.size ? asset : largest,
  );
  require((await publicDigest(release.tagName, name, largeUploadTimeout)) ===
    digest, `Anonymous SHA-256 mismatch for ${name}`);
  console.log(
    `Verified ${release.assets.length} GitCode attachments and anonymous download of ${name} (${size} bytes)`,
  );
}

async function run() {
  require(metadataFile &&
    assetDir &&
    mode, "Expected a release manifest, asset directory and mode");
  const release = JSON.parse(await readFile(metadataFile, "utf8"));
  const tag = release.tagName;
  require(/^v[0-9]+\.[0-9]+\.[0-9]+-gitcode-test\.[0-9]{8}\.[0-9]+$/.test(tag) &&
    release.isPrerelease &&
    !release.isDraft, "Only published test prereleases can be mirrored by this rehearsal");
  require(Array.isArray(release.assets) &&
    release.assets.length > 0, "GitHub Release must include assets");
  if (mode === "plan") {
    const groups = Math.ceil(
      release.assets.filter(({ size }) => size > smallAssetLimit).length / largeAssetsPerBatch,
    );
    console.log(JSON.stringify(Array.from({ length: groups + 1 }, (_, batch) => batch)));
    return;
  }
  if (mode === "list") {
    for (const { name } of batchAssets(release.assets, Number(batchNumber))) console.log(name);
    return;
  }
  require(/^[A-Za-z0-9_-]+\/penguin-harness-release-test$/.test(
    repo ?? "",
  ), "Set GITCODE_REPO to the personal test repository");
  require(token, "Set GITCODE_TOKEN in the GitHub gitcode-release-test environment");
  const releasePath = `/releases/tags/${tag}`;
  if (mode === "verify") return verifyRelease(release, releasePath);
  require(mode === "upload", "Unknown mirror mode");
  const selected = batchAssets(release.assets, Number(batchNumber));
  if (!selected.length) return;
  const files = await inspectAssets(selected);
  const commit = ensureTag(tag);
  const existing =
    (await api(releasePath, "GET", undefined, true)) ??
    (await api("/releases", "POST", {
      tag_name: tag,
      target_commitish: commit,
      name: release.name,
      body: release.body,
      release_status: "pre",
    }));
  require(existing.tag_name === tag &&
    existing.prerelease === true, "Expected a GitCode test prerelease");

  const uploaded = attachments(existing);
  const attempted = new Map();
  for (const [name, file] of files) {
    if (uploaded.has(name)) {
      await verifyAsset(tag, name, file, uploaded.get(name));
      console.log(`Already verified: ${name}`);
      continue;
    }
    attempted.set(name, file);
    try {
      await upload(tag, name, file);
    } catch (error) {
      console.error(error.message);
    }
  }
  if (!attempted.size) return;

  for (let attempt = 0; attempt < 10; attempt++) {
    const current = attachments(await api(releasePath));
    for (const [name, file] of attempted) {
      if (!current.has(name)) continue;
      await verifyAsset(tag, name, file, current.get(name));
      attempted.delete(name);
    }
    if (!attempted.size) return;
    if (attempt < 9) await delay(3000);
  }
  throw new Error(
    `GitCode still lacks these batch attachments: ${[...attempted.keys()].join(", ")}`,
  );
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
