// Telegram webhook: photo in → background removed → committed to the repo → site redeploys.
import sharp from "sharp";
import exifReader from "exif-reader";
import config from "../site.config.json" with { type: "json" };

const env = (k) => (process.env[k] || "").trim();
const TG_TOKEN = env("TELEGRAM_BOT_TOKEN");
const ALLOWED_ID = env("ALLOWED_TELEGRAM_USER_ID").replace(/\D/g, "");
const WEBHOOK_SECRET = env("TELEGRAM_WEBHOOK_SECRET");
const REPLICATE_TOKEN = env("REPLICATE_API_TOKEN");
const GH_TOKEN = env("GITHUB_TOKEN");
const GH_REPO =
  env("GITHUB_REPO") ||
  (env("VERCEL_GIT_REPO_OWNER") && `${env("VERCEL_GIT_REPO_OWNER")}/${env("VERCEL_GIT_REPO_SLUG")}`);

const COLL = config.collection;
const BG_MODEL = "851-labs/background-remover";
const COST_PER_ITEM = 0.0005;

export default async function handler(req, res) {
  // Always answer 200, otherwise Telegram keeps re-delivering the update.
  if (req.method !== "POST") return res.status(200).send("ok");
  if (!WEBHOOK_SECRET || req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
    return res.status(200).send("ok");
  }
  const msg = req.body?.message;
  if (!msg || String(msg.from?.id) !== ALLOWED_ID) return res.status(200).send("ok");

  try {
    await handleMessage(msg);
  } catch (err) {
    console.error(err);
    await tg("sendMessage", { chat_id: msg.chat.id, text: `⚠️ Nie udało się: ${err.message || err}` }).catch(() => {});
  }
  return res.status(200).send("ok");
}

async function handleMessage(msg) {
  const chat_id = msg.chat.id;
  const text = (msg.text || "").trim();

  if (text.startsWith("/delete")) return handleDelete(msg);
  if (text.startsWith("/stats")) return handleStats(chat_id);

  const fileId =
    msg.photo?.at(-1)?.file_id ||
    (msg.document?.mime_type?.startsWith("image/") ? msg.document.file_id : null);
  if (!fileId) {
    return tg("sendMessage", {
      chat_id,
      text:
        "Wyślij zdjęcie (podpis = tytuł), a pojawi się na stronie.\n" +
        "Wyślij jako „Plik”, żeby zachować lokalizację GPS.\n\n" +
        "/delete — odpowiedz tym na moje potwierdzenie, żeby usunąć przedmiot\n" +
        "/stats — statystyki kolekcji",
    });
  }

  await tg("sendChatAction", { chat_id, action: "upload_photo" }).catch(() => {});

  // 1. Download the original from Telegram
  const file = await tg("getFile", { file_id: fileId });
  const origRes = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${file.file_path}`);
  if (!origRes.ok) throw new Error(`Pobranie zdjęcia z Telegrama: HTTP ${origRes.status}`);
  const original = Buffer.from(await origRes.arrayBuffer());

  // 2. GPS from EXIF (only survives "send as File") → place name
  const meta = await sharp(original).metadata();
  const gps = readGps(meta.exif);
  const location = gps ? await reverseGeocode(gps.lat, gps.lng).catch(() => null) : null;

  // 3. Background removal. Upright + capped input keeps the upload small.
  const input = await sharp(original)
    .rotate()
    .resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();
  const cutoutUrl = await removeBackground(input);
  const cutoutRes = await fetch(cutoutUrl);
  if (!cutoutRes.ok) throw new Error(`Pobranie wyciętego obrazu: HTTP ${cutoutRes.status}`);
  const cutout = Buffer.from(await cutoutRes.arrayBuffer());

  // 4. Trim transparent padding, encode full + thumb, dominant colour
  const trimmed = await sharp(cutout).trim().png().toBuffer().catch(() => cutout);
  const full = await sharp(trimmed)
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  const thumb = await sharp(trimmed)
    .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  const { dominant } = await sharp(trimmed).stats();
  const color = "#" + [dominant.r, dominant.g, dominant.b].map((v) => v.toString(16).padStart(2, "0")).join("");

  // 5. Commit image + thumb + JSON in one commit.
  // Slug is derived from the message id, so a re-delivered update overwrites instead of duplicating.
  const date = new Date(msg.date * 1000);
  const slug = `${date.toISOString().slice(0, 10).replace(/-/g, "")}-${msg.message_id.toString(36).padStart(4, "0")}`;
  const title = (msg.caption || "").trim() || "bez tytułu";
  const item = {
    title,
    date: date.toISOString(),
    image: `/${COLL}/${slug}.webp`,
    thumb: `/${COLL}/${slug}-thumb.webp`,
    width: full.info.width,
    height: full.info.height,
    color,
    ...(location ? { location } : {}),
    ...(gps ? { lat: round(gps.lat), lng: round(gps.lng) } : {}),
  };
  await commit(`Add ${slug}: ${title}`, [
    { path: `public/${COLL}/${slug}.webp`, content: full.data },
    { path: `public/${COLL}/${slug}-thumb.webp`, content: thumb },
    { path: `src/content/${COLL}/${slug}.json`, content: Buffer.from(JSON.stringify(item, null, 2) + "\n") },
  ]);

  // 6. Confirmation with the processed preview. "slug: …" is what /delete parses.
  const preview = await sharp(trimmed)
    .resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
  const caption = [
    `✅ ${title}`,
    location && `📍 ${location}`,
    "Na stronie za ok. 2 min.",
    `slug: ${slug}`,
  ].filter(Boolean).join("\n");
  await sendPhoto(chat_id, preview, caption, msg.message_id);
}

async function handleDelete(msg) {
  const chat_id = msg.chat.id;
  const replied = msg.reply_to_message;
  const slug = (replied?.caption || replied?.text || "").match(/slug:\s*(\S+)/)?.[1];
  if (!slug) {
    return tg("sendMessage", { chat_id, text: "Odpowiedz komendą /delete na moje potwierdzenie (to z „slug: …”)." });
  }
  await commit(`Delete ${slug}`, [
    { path: `public/${COLL}/${slug}.webp`, content: null },
    { path: `public/${COLL}/${slug}-thumb.webp`, content: null },
    { path: `src/content/${COLL}/${slug}.json`, content: null },
  ]);
  await tg("sendMessage", { chat_id, text: `🗑 Usunięto ${slug}. Zniknie ze strony za ok. 2 min.` });
}

async function handleStats(chat_id) {
  const list = await gh(`/repos/${GH_REPO}/contents/src/content/${COLL}`).catch((e) => {
    if (e.status === 404) return [];
    throw e;
  });
  const slugs = list.filter((f) => f.name.endsWith(".json")).map((f) => f.name.slice(0, -5)).sort();
  const day = (s) => s && `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}`;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const month = today.slice(0, 6);
  const lines = [
    `📦 Przedmiotów: ${slugs.length}`,
    `W tym miesiącu: ${slugs.filter((s) => s.startsWith(month)).length}`,
    slugs.length && `Pierwszy: ${day(slugs[0])}`,
    slugs.length && `Ostatni: ${day(slugs.at(-1))}`,
    `💸 Koszt przetwarzania: ~$${(slugs.length * COST_PER_ITEM).toFixed(3)}`,
  ].filter(Boolean);
  await tg("sendMessage", { chat_id, text: lines.join("\n") });
}

// ---------- EXIF / geocoding ----------

function readGps(exifBuf) {
  if (!exifBuf) return null;
  try {
    const g = exifReader(exifBuf).GPSInfo;
    if (!g?.GPSLatitude || !g?.GPSLongitude) return null;
    const dms = ([d, m = 0, s = 0]) => d + m / 60 + s / 3600;
    let lat = dms(g.GPSLatitude);
    let lng = dms(g.GPSLongitude);
    if (g.GPSLatitudeRef === "S") lat = -lat;
    if (g.GPSLongitudeRef === "W") lng = -lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=pl&lat=${lat}&lon=${lng}`;
  const r = await fetch(url, { headers: { "User-Agent": `${GH_REPO || "collection-site"} telegram bot` } });
  if (!r.ok) return null;
  const a = (await r.json()).address || {};
  const street = a.road || a.pedestrian || a.square || a.neighbourhood || a.suburb;
  const city = a.city || a.town || a.village || a.municipality;
  return [street, city].filter(Boolean).join(", ") || null;
}

const round = (n) => Math.round(n * 1e4) / 1e4;

// ---------- Replicate ----------

async function removeBackground(jpeg) {
  const upload = new FormData();
  upload.append("content", new Blob([jpeg], { type: "image/jpeg" }), "photo.jpg");
  const file = await replicate("/v1/files", { method: "POST", body: upload });

  // Community model: the model-named predictions endpoint 404s, so resolve the version first.
  const model = await replicate(`/v1/models/${BG_MODEL}`);
  const version = model.latest_version?.id;
  if (!version) throw new Error(`Replicate: brak wersji modelu ${BG_MODEL}`);

  let p = await replicate("/v1/predictions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "wait=40" },
    body: JSON.stringify({ version, input: { image: file.urls.get } }),
  });
  while (!["succeeded", "failed", "canceled"].includes(p.status)) {
    await sleep(1000);
    p = await replicate(p.urls.get);
  }
  if (p.status !== "succeeded") throw new Error(`Replicate: ${p.error || p.status}`);
  const out = Array.isArray(p.output) ? p.output[0] : p.output;
  if (typeof out !== "string") throw new Error("Replicate: nieoczekiwany wynik modelu");
  return out;
}

async function replicate(path, opts = {}) {
  const url = path.startsWith("http") ? path : `https://api.replicate.com${path}`;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, ...(opts.headers || {}) },
    });
    // Accounts under $5 credit are throttled to 1 request/min burst.
    if (r.status === 429 && attempt < 3) {
      await sleep(11000);
      continue;
    }
    if (!r.ok) throw new Error(`Replicate HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
}

// ---------- GitHub (Git Data API: one atomic commit) ----------

async function gh(path, opts = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!r.ok) {
    const err = new Error(`GitHub HTTP ${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function commit(message, files) {
  if (!GH_REPO) throw new Error("Brak GITHUB_REPO (właściciel/nazwa repozytorium)");
  const repo = `/repos/${GH_REPO}`;
  const { default_branch: branch } = await gh(repo);

  const blobs = await Promise.all(
    files.map(async (f) =>
      f.content === null
        ? { path: f.path, mode: "100644", type: "blob", sha: null }
        : {
            path: f.path,
            mode: "100644",
            type: "blob",
            sha: (
              await gh(`${repo}/git/blobs`, {
                method: "POST",
                body: JSON.stringify({ content: f.content.toString("base64"), encoding: "base64" }),
              })
            ).sha,
          }
    )
  );

  // Retry if another commit (e.g. a second photo sent at the same time) moved the branch.
  for (let attempt = 0; ; attempt++) {
    const ref = await gh(`${repo}/git/ref/heads/${branch}`);
    const parent = await gh(`${repo}/git/commits/${ref.object.sha}`);
    const tree = await gh(`${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: parent.tree.sha, tree: blobs }),
    });
    const c = await gh(`${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message, tree: tree.sha, parents: [parent.sha] }),
    });
    try {
      await gh(`${repo}/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: c.sha }),
      });
      return c.sha;
    } catch (e) {
      if (e.status !== 422 || attempt >= 3) throw e;
      await sleep(500 + Math.random() * 1000);
    }
  }
}

// ---------- Telegram ----------

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}

async function sendPhoto(chat_id, jpeg, caption, reply_to) {
  const form = new FormData();
  form.append("chat_id", String(chat_id));
  form.append("caption", caption);
  form.append("reply_parameters", JSON.stringify({ message_id: reply_to, allow_sending_without_reply: true }));
  form.append("photo", new Blob([jpeg], { type: "image/jpeg" }), "preview.jpg");
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method: "POST", body: form });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram sendPhoto: ${j.description}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
