import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || "claude-sonnet-4-20250514";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CACHE_SCHEMA_VERSION = "v6_multi_agent_pipeline_trimmed_debate_fix_compare";

app.use(express.json({ limit: "20mb" }));
app.use(express.static("public"));

const DATA_DIR = path.join(process.cwd(), "data");
const CACHE_FILE = path.join(DATA_DIR, "image-score-cache.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadPersistentCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePersistentCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

const persistentCache = loadPersistentCache();
let previousSession = null;

const AGENTS = [
  {
    key: "influencer",
    name: "Influencer",
    role: "Highly aesthetic, trend-aware, image-conscious, visually demanding"
  },
  {
    key: "musicLover",
    name: "Music Lover",
    role: "Judges song choice, emotional fit, mood alignment, and sonic storytelling"
  },
  {
    key: "averageAudience",
    name: "Average Audience",
    role: "Instinctive mainstream social reaction, low-patience, quick emotional read"
  },
  {
    key: "friend",
    name: "Friend",
    role: "Honest friend who wants the strongest possible post, supportive but not fake"
  }
];

function safeJsonParse(text) {
  if (!text || typeof text !== "string") return null;

  const trimmed = text.trim();
  const attempts = [];

  attempts.push(trimmed);
  attempts.push(trimmed.replace(/```json/gi, "").replace(/```/g, "").trim());

  if (trimmed.includes("END_JSON")) {
    attempts.push(trimmed.split("END_JSON")[ 0 ].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    attempts.push(trimmed.slice(firstBrace, lastBrace + 1).trim());
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying
    }
  }

  return null;
}

function clamp(value, min, max) {
  const num = Number(value);
  if (Number.isNaN(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function normalizeAttr(attr = {}) {
  return {
    attention_grabbing: clamp(attr.attention_grabbing ?? 0, 0, 1),
    aesthetic_quality: clamp(attr.aesthetic_quality ?? 0, 0, 1),
    authenticity: clamp(attr.authenticity ?? 0, 0, 1),
    confidence: clamp(attr.confidence ?? 0, 0, 1),
    relatability: clamp(attr.relatability ?? 0, 0, 1),
    good_lighting: clamp(attr.good_lighting ?? 0, 0, 1),
    hairstyle_quality: clamp(attr.hairstyle_quality ?? 0, 0, 1),
    cringe_risk: clamp(attr.cringe_risk ?? 0, 0, 1)
  };
}

function computeScore(attr) {
  const clean = normalizeAttr(attr);

  const positive =
    0.20 * clean.attention_grabbing +
    0.18 * clean.aesthetic_quality +
    0.16 * clean.authenticity +
    0.14 * clean.confidence +
    0.10 * clean.relatability +
    0.12 * clean.good_lighting +
    0.10 * clean.hairstyle_quality;

  const cringePenalty = 0.30 * (clean.cringe_risk ** 1.45);

  const hairstylePenalty =
    clean.hairstyle_quality < 0.45
      ? 0.12 * ((0.45 - clean.hairstyle_quality) / 0.45)
      : 0;

  const final = positive - cringePenalty - hairstylePenalty;
  return Math.max(0, Math.min(1, final));
}

function toPercent(score01) {
  return Math.round(clamp(score01, 0, 1) * 100);
}

function toTen(score01) {
  return Math.round(clamp(score01, 0, 1) * 100) / 10;
}

function sha256String(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sha256Base64(base64String = "") {
  return sha256String(base64String);
}

function normalizeText(value = "") {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function buildMetadataSignature({ song = "", caption = "", context = "" }) {
  return JSON.stringify({
    song: normalizeText(song).toLowerCase(),
    caption: normalizeText(caption).toLowerCase(),
    context: normalizeText(context).toLowerCase()
  });
}

function buildCompositeCacheKey({ imageHash, song, caption, context }) {
  const metadataSignature = buildMetadataSignature({ song, caption, context });
  return sha256String(
    `${ CACHE_SCHEMA_VERSION }::${ imageHash }::${ metadataSignature }`
  );
}

function pseudoPerceptualHash(base64String = "") {
  const buffer = Buffer.from(base64String, "base64");
  if (!buffer.length) return "0".repeat(64);

  const bucketCount = 64;
  const buckets = new Array(bucketCount).fill(0);

  for (let i = 0; i < buffer.length; i++) {
    buckets[ i % bucketCount ] += buffer[ i ];
  }

  const avg = buckets.reduce((sum, value) => sum + value, 0) / bucketCount;
  return buckets.map((value) => (value >= avg ? "1" : "0")).join("");
}

function hammingDistance(a = "", b = "") {
  const len = Math.min(a.length, b.length);
  let distance = Math.abs(a.length - b.length);

  for (let i = 0; i < len; i++) {
    if (a[ i ] !== b[ i ]) distance += 1;
  }

  return distance;
}

function getSimilarityLabel(currentSession, previous) {
  if (!previous?.imageHash || !previous?.perceptualHash) {
    return {
      exactMatch: false,
      similar: false,
      sameVisual: false,
      metadataChanged: false,
      distance: null,
      shouldCompare: false,
      message: "No previous image exists, so this is being judged fresh on its own merits."
    };
  }

  const exactMatch = currentSession.imageHash === previous.imageHash;
  const distance = hammingDistance(
    currentSession.perceptualHash,
    previous.perceptualHash
  );

  const similar = !exactMatch && distance <= 8;
  const sameVisual = exactMatch || similar;

  const metadataChanged =
    sameVisual &&
    currentSession.metadataSignature !== previous.metadataSignature;

  const shouldCompare = sameVisual;

  let message = "This image is being judged on its own merits. No valid visual comparison to the previous image was detected.";

  if (exactMatch && metadataChanged) {
    message =
      "This is the exact same image, but the song, caption, or context changed, so it must be judged from a new perspective.";
  } else if (exactMatch && !metadataChanged) {
    message = "This is the exact same image with the same metadata as before.";
  } else if (similar && metadataChanged) {
    message =
      "This image is visually similar to the previous upload and the metadata changed, so it should be treated as a revised version with a new framing.";
  } else if (similar) {
    message =
      "This image is visually similar to the previous upload and should be treated as a follow-up, alternate take, improvement, or decline comparison.";
  }

  return {
    exactMatch,
    similar,
    sameVisual,
    metadataChanged,
    distance,
    shouldCompare,
    message
  };
}

function shouldCompareWithPrevious(similarity) {
  return Boolean(similarity?.exactMatch || similarity?.similar);
}

function shouldSendPreviousImage(similarity) {
  return Boolean(similarity?.shouldCompare);
}

function sanitizeSuggestions(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3);
}

function sanitizeDebateLayer(layer = {}) {
  const debate = Array.isArray(layer.debate)
    ? layer.debate.slice(0, 20).map((item) => ({
      round: Number(item?.round) || 1,
      speaker: String(item?.speaker || "").trim(),
      replyingTo: String(item?.replyingTo || "").trim(),
      stance: String(item?.stance || "").trim(),
      message: String(item?.message || "").trim()
    }))
    : [];

  const convincing = Array.isArray(layer.convincing)
    ? layer.convincing.slice(0, 8).map((item) => ({
      speaker: String(item?.speaker || "").trim(),
      changedMind: String(item?.changedMind || "").trim(),
      because: String(item?.because || "").trim()
    }))
    : [];

  const conclusion = {
    consensusSummary: String(layer?.conclusion?.consensusSummary || "").trim(),
    finalDecision: String(layer?.conclusion?.finalDecision || "").trim(),
    why: String(layer?.conclusion?.why || "").trim()
  };

  return { debate, convincing, conclusion };
}

function buildPreviousSnapshot(previousResult) {
  if (!previousResult) return null;

  return {
    overallScorePercent: previousResult.summary?.likeliness ?? null,
    overallRating10: previousResult.summary?.overallRating10 ?? null,
    finalDecision: previousResult.summary?.finalDecision ?? null,
    agents: {
      influencer: previousResult.influencer
        ? {
          scorePercent: previousResult.influencer.scorePercent,
          verdict: previousResult.influencer.verdict
        }
        : null,
      musicLover: previousResult.musicLover
        ? {
          scorePercent: previousResult.musicLover.scorePercent,
          verdict: previousResult.musicLover.verdict
        }
        : null,
      averageAudience: previousResult.averageAudience
        ? {
          scorePercent: previousResult.averageAudience.scorePercent,
          verdict: previousResult.averageAudience.verdict
        }
        : null,
      friend: previousResult.friend
        ? {
          scorePercent: previousResult.friend.scorePercent,
          verdict: previousResult.friend.verdict
        }
        : null
    }
  };
}

function buildAgentPrompt(agent, current, previous, similarity, previousResult) {
  const previousExists = Boolean(previous?.imageBase64);
  const previousAgent = previousResult?.[ agent.key ];

  return `
You are acting as ONE independent Instagram post evaluator.

AGENT NAME: ${ agent.name }
AGENT ROLE: ${ agent.role }

CURRENT POST:
- Song: ${ current.song || "none" }
- Caption: ${ current.caption || "none" }
- Context: ${ current.context || "none" }

PREVIOUS STATUS:
- Previous image exists: ${ previousExists ? "yes" : "no" }
- Similarity assessment: ${ similarity.message }
- Similarity distance: ${ similarity.distance ?? "n/a" }
- Metadata changed vs previous: ${ similarity.metadataChanged ? "yes" : "no" }

${ previousExists
      ? `PREVIOUS POST:
- Previous song: ${ previous.song || "none" }
- Previous caption: ${ previous.caption || "none" }
- Previous context: ${ previous.context || "none" }`
      : ""
    }

${ previousAgent
      ? `YOUR PREVIOUS SCORE:
- Previous score: ${ previousAgent.scorePercent ?? "n/a" }%
- Previous verdict: ${ previousAgent.verdict || "n/a" }`
      : ""
    }

CRITICAL INDEPENDENCE RULES:
- You are NOT collaborating with any other agent yet.
- Do NOT anticipate what other agents will say.
- Be stubborn and internally consistent to your own role.
- Do not soften your view just because another agent might disagree.
- Judge from your own perspective only.

SCORING:
Assign these eight numeric attributes from 0 to 1:
- attention_grabbing
- aesthetic_quality
- authenticity
- confidence
- relatability
- good_lighting
- hairstyle_quality
- cringe_risk

REACTION RULES:
- Write exactly 4 short-but-substantive sentences.
- If there is a previous similar image or metadata change, include one sentence explicitly comparing this version to the previous one.
- Explain WHY the post works or fails from your specific perspective.

SPECIALIST RULES:
${ agent.key === "musicLover"
      ? `- You may recommend top 3 replacement songs ONLY if the current song is weak, missing, or mismatched.
- If the current song already works well, return an empty array.`
      : `- Do not recommend songs.`
    }

${ agent.key === "influencer"
      ? `- You may recommend top 3 replacement captions ONLY if the current caption is weak, missing, generic, or mismatched.
- If the current caption already works well, return an empty array.`
      : `- Do not recommend captions.`
    }

Return ONLY valid raw JSON.
You MUST complete the entire JSON object fully.
End the response with END_JSON

{
  "reaction": "...",
  "verdict": "...",
  "scoreChangeReason": "...",
  ${ agent.key === "influencer"
      ? `"captionSuggestions": ["...", "...", "..."],`
      : ""
    }
  ${ agent.key === "musicLover"
      ? `"songSuggestions": ["...", "...", "..."],`
      : ""
    }
  "attributes": {
    "attention_grabbing": 0.00,
    "aesthetic_quality": 0.00,
    "authenticity": 0.00,
    "confidence": 0.00,
    "relatability": 0.00,
    "good_lighting": 0.00,
    "hairstyle_quality": 0.00,
    "cringe_risk": 0.00
  }
}
`.trim();
}

function buildDebatePrompt(agentResults, comparison, previousResult) {
  const compactAgents = AGENTS.map((agent) => {
    const item = agentResults[ agent.key ];
    return {
      agent: agent.key,
      role: agent.role,
      reaction: item.reaction,
      verdict: item.verdict,
      scorePercent: item.scorePercent,
      scoreChangeReason: item.scoreChangeReason,
      attributes: item.attributes
    };
  });

  return `
You are running a structured debate between 4 already-independent agents.

COMPARISON CONTEXT:
${ JSON.stringify(comparison, null, 2) }

PREVIOUS RESULT SNAPSHOT:
${ JSON.stringify(buildPreviousSnapshot(previousResult), null, 2) }

AGENT POSITIONS:
${ JSON.stringify(compactAgents, null, 2) }

DEBATE GOAL:
- Preserve disagreement where it is natural.
- Do NOT let agents change their minds too easily.
- Only allow mind changes if another agent made a genuinely strong, specific case.
- Human disagreement should feel stubborn, not flimsy.

DEBATE:
- exactly 5 rounds
- exactly 8 messages total
- messages should challenge, defend, refine, support, or concede
- every message 1-2 sentences
- use actual disagreements from the agent positions above

CONVINCING:
- 4 items total, one per agent
- changedMind should be "yes", "partially", or "no"
- prefer "no" or "partially" unless there is a genuinely strong reason
- keep each "because" explanation to 1 short sentence

CONCLUSION:
- consensusSummary = 2 short sentences
- finalDecision = 1 short sentence
- why = 1 short sentence

You MUST complete the entire JSON object fully.
Do not stop mid-array or mid-sentence.

Return ONLY valid raw JSON.
End the response with END_JSON

{
  "debate": [
    {
      "round": 1,
      "speaker": "influencer",
      "replyingTo": "averageAudience",
      "stance": "challenge",
      "message": "..."
    }
  ],
  "convincing": [
    {
      "speaker": "influencer",
      "changedMind": "partially",
      "because": "..."
    }
  ],
  "conclusion": {
    "consensusSummary": "...",
    "finalDecision": "...",
    "why": "..."
  }
}
`.trim();
}

function buildFinalPrompt(agentResults, debateLayer, comparison, previousResult) {
  const compactAgents = AGENTS.map((agent) => {
    const item = agentResults[ agent.key ];
    return {
      agent: agent.key,
      reaction: item.reaction,
      verdict: item.verdict,
      scorePercent: item.scorePercent,
      scoreChangeReason: item.scoreChangeReason,
      attributes: item.attributes,
      songSuggestions: item.songSuggestions || [],
      captionSuggestions: item.captionSuggestions || []
    };
  });

  return `
You are the final synthesis step for an Instagram post evaluation system.

COMPARISON CONTEXT:
${ JSON.stringify(comparison, null, 2) }

PREVIOUS RESULT SNAPSHOT:
${ JSON.stringify(buildPreviousSnapshot(previousResult), null, 2) }

AGENT RESULTS:
${ JSON.stringify(compactAgents, null, 2) }

DEBATE LAYER:
${ JSON.stringify(debateLayer, null, 2) }

TASK:
Produce the final high-level summary after considering:
- the individual agents
- the debate
- the convincing phase
- the conclusion

IMPORTANT:
- Be faithful to the debate.
- Do not erase real disagreement.
- Explain clearly why the score changed, stayed stable, or shifted.
- Keep it concise but insightful.

Return ONLY valid raw JSON.
You MUST complete the entire JSON object fully.
End the response with END_JSON

{
  "expectedViewers": "1 sentence",
  "agentInteractions": ["...", "...", "..."],
  "godsEyeInsight": "2-3 sentences",
  "bitterTruth": "2 sentences",
  "finalDecision": "short direct recommendation",
  "overallScoreChangeReason": "..."
}
`.trim();
}

async function callAnthropic(content, maxTokens = 1200, temperature = 0.35) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        temperature,
        messages: [ { role: "user", content } ]
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data?.error?.message || `Anthropic API error (${ response.status })`);
    }

    let rawText =
      (data?.content || []).find((item) => item.type === "text")?.text || "";

    if (rawText.includes("END_JSON")) {
      rawText = rawText.split("END_JSON")[ 0 ].trim();
    }

    const parsed = safeJsonParse(rawText);

    if (!parsed) {
      const err = new Error("Model returned non-JSON output.");
      err.raw = rawText;
      throw err;
    }

    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function getConsensusNote(agentScores) {
  const strongCount = agentScores.filter((score) => score >= 0.7).length;

  if (strongCount === 4) return "acknowledged by all 4 agents";
  if (strongCount === 3) return "endorsed by 3 of 4 agents";
  if (strongCount === 2) return "split 2 to 2 across the agents";
  if (strongCount === 1) return "supported by only 1 of the 4 agents";
  return "not strongly backed by the agents";
}

function buildScoreBreakdown(attrs) {
  const a = normalizeAttr(attrs);
  return {
    attention_grabbing: Math.round(0.20 * a.attention_grabbing * 100),
    aesthetic_quality: Math.round(0.18 * a.aesthetic_quality * 100),
    authenticity: Math.round(0.16 * a.authenticity * 100),
    confidence: Math.round(0.14 * a.confidence * 100),
    relatability: Math.round(0.10 * a.relatability * 100),
    good_lighting: Math.round(0.12 * a.good_lighting * 100),
    hairstyle_quality: Math.round(0.10 * a.hairstyle_quality * 100),
    cringe_penalty: -Math.round(0.30 * (a.cringe_risk ** 1.45) * 100),
    hairstyle_penalty:
      a.hairstyle_quality < 0.45
        ? -Math.round(0.12 * ((0.45 - a.hairstyle_quality) / 0.45) * 100)
        : 0
  };
}

function enrichResult(agentResults, debateLayer, summary, currentSession, similarity) {
  const enriched = {};
  const scoreList = [];
  let total = 0;
  let count = 0;

  const previousResult =
    shouldCompareWithPrevious(similarity) ? previousSession?.lastResult || null : null;

  for (const agent of AGENTS) {
    const item = structuredClone(agentResults[ agent.key ] || {});
    const attrs = normalizeAttr(item.attributes || {});
    const score01 = computeScore(attrs);
    const scorePercent = toPercent(score01);

    item.attributes = attrs;
    item.score01 = Number(score01.toFixed(4));
    item.scorePercent = scorePercent;
    item.scoreBreakdown = buildScoreBreakdown(attrs);
    item.scoreChangeReason = String(item.scoreChangeReason || "").trim();

    if (agent.key === "musicLover") {
      item.songSuggestions = sanitizeSuggestions(item.songSuggestions);
    }

    if (agent.key === "influencer") {
      item.captionSuggestions = sanitizeSuggestions(item.captionSuggestions);
    }

    if (previousResult?.[ agent.key ]?.scorePercent != null) {
      item.previousScorePercent = previousResult[ agent.key ].scorePercent;
      item.scoreDelta = scorePercent - previousResult[ agent.key ].scorePercent;
      item.previousVerdict = previousResult[ agent.key ].verdict || "";
    } else {
      item.previousScorePercent = null;
      item.scoreDelta = null;
      item.previousVerdict = "";
    }

    enriched[ agent.key ] = item;
    total += score01;
    count += 1;
    scoreList.push(score01);
  }

  const overall01 = count ? total / count : 0;
  const overallPercent = toPercent(overall01);
  const overall10 = toTen(overall01);
  const consensusNote = getConsensusNote(scoreList);

  let previousOverallPercent = null;
  let previousOverall10 = null;
  let overallDelta = null;

  if (previousResult?.summary?.likeliness != null) {
    previousOverallPercent = previousResult.summary.likeliness;
    previousOverall10 = previousResult.summary.overallRating10 ?? null;
    overallDelta = overallPercent - previousOverallPercent;
  }

  enriched.comparison = {
    acknowledged_previous_image: shouldCompareWithPrevious(similarity),
    same_image: similarity.exactMatch,
    similar_image: similarity.similar,
    metadata_changed: similarity.metadataChanged,
    similarity_distance: similarity.distance,
    comparison_summary: shouldCompareWithPrevious(similarity)
      ? similarity.message
      : "This image is being judged on its own merits. No valid visual comparison to the previous image was detected."
  };

  enriched.debateLayer = sanitizeDebateLayer(debateLayer || {});

  enriched.summary = {
    ...(summary || {}),
    likeliness: overallPercent,
    confidence:
      similarity.exactMatch
        ? 100
        : similarity.similar
          ? 88
          : 80,
    overallScore01: Number(overall01.toFixed(4)),
    overallRating10: overall10,
    consensusNote,
    exactImageHash: currentSession.imageHash,
    metadataSignature: currentSession.metadataSignature,
    cacheKey: currentSession.cacheKey,
    scoreStability:
      "Exact same image + same song/caption/context reuses the saved score. Same image with changed metadata gets a fresh analysis.",
    previousOverallPercent,
    previousOverall10,
    overallDelta,
    overallScoreChangeReason: String(summary?.overallScoreChangeReason || "").trim()
  };

  enriched.comparisonSnapshot =
    shouldCompareWithPrevious(similarity) && previousResult
      ? buildPreviousSnapshot(previousResult)
      : null;

  return enriched;
}

app.post("/api/analyze", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: "Server is missing ANTHROPIC_API_KEY in .env"
      });
    }

    const {
      imageBase64 = "",
      song = "",
      caption = "",
      context = ""
    } = req.body || {};

    if (!imageBase64 && !song) {
      return res.status(400).json({
        error: "Provide at least an image or a song title."
      });
    }

    const imageHash = sha256Base64(imageBase64);
    const metadataSignature = buildMetadataSignature({ song, caption, context });
    const cacheKey = buildCompositeCacheKey({
      imageHash,
      song,
      caption,
      context
    });

    const currentSession = {
      imageBase64,
      song,
      caption,
      context,
      imageHash,
      metadataSignature,
      cacheKey,
      perceptualHash: pseudoPerceptualHash(imageBase64),
      hasPreviousImage: Boolean(previousSession?.imageBase64)
    };

    if (persistentCache[ currentSession.cacheKey ]) {
      const cached = structuredClone(persistentCache[ currentSession.cacheKey ]);

      cached.comparison = {
        ...(cached.comparison || {}),
        acknowledged_previous_image: true,
        same_image: previousSession?.imageHash === currentSession.imageHash,
        similar_image: false,
        metadata_changed:
          previousSession?.metadataSignature &&
          previousSession.metadataSignature !== currentSession.metadataSignature,
        similarity_distance: previousSession?.perceptualHash
          ? hammingDistance(currentSession.perceptualHash, previousSession.perceptualHash)
          : null,
        comparison_summary:
          "This exact image with the same song/caption/context has been seen before, so the stored score was reused."
      };

      cached.summary = {
        ...(cached.summary || {}),
        metadataSignature: currentSession.metadataSignature,
        cacheKey: currentSession.cacheKey,
        scoreStability:
          "This exact image+metadata combination matched a saved cache entry, so the same score was reused."
      };

      currentSession.lastResult = cached;
      previousSession = currentSession;

      return res.json({
        ok: true,
        result: cached,
        cached: true,
        persistent: true
      });
    }

    const similarity = getSimilarityLabel(currentSession, previousSession);

    const agentPromises = AGENTS.map(async (agent) => {
      const content = [];

      if (imageBase64) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: imageBase64
          }
        });
      }

      if (shouldSendPreviousImage(similarity) && previousSession?.imageBase64) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: previousSession.imageBase64
          }
        });
      }

      content.push({
        type: "text",
        text: buildAgentPrompt(
          agent,
          { song, caption, context },
          shouldCompareWithPrevious(similarity) ? previousSession : null,
          similarity,
          shouldCompareWithPrevious(similarity)
            ? previousSession?.lastResult || null
            : null
        )
      });

      const result = await callAnthropic(content, 950, 0.35);
      return [ agent.key, result ];
    });

    const agentEntries = await Promise.all(agentPromises);
    const agentResults = Object.fromEntries(agentEntries);

    const agentResultsWithScores = {};
    for (const agent of AGENTS) {
      const item = structuredClone(agentResults[ agent.key ] || {});
      const attrs = normalizeAttr(item.attributes || {});
      const score01 = computeScore(attrs);
      item.attributes = attrs;
      item.scorePercent = toPercent(score01);
      agentResultsWithScores[ agent.key ] = item;
    }

    const debateContent = [
      {
        type: "text",
        text: buildDebatePrompt(
          agentResultsWithScores,
          similarity,
          shouldCompareWithPrevious(similarity)
            ? previousSession?.lastResult || null
            : null
        )
      }
    ];

    const debateLayer = await callAnthropic(debateContent, 1800, 0.35);

    const finalContent = [
      {
        type: "text",
        text: buildFinalPrompt(
          agentResultsWithScores,
          debateLayer,
          similarity,
          shouldCompareWithPrevious(similarity)
            ? previousSession?.lastResult || null
            : null
        )
      }
    ];

    const finalSummary = await callAnthropic(finalContent, 950, 0.3);

    const enriched = enrichResult(
      agentResults,
      debateLayer,
      finalSummary,
      currentSession,
      similarity
    );

    persistentCache[ currentSession.cacheKey ] = structuredClone(enriched);
    savePersistentCache(persistentCache);

    currentSession.lastResult = enriched;
    previousSession = currentSession;

    return res.json({
      ok: true,
      result: enriched,
      cached: false,
      persistent: false
    });
  } catch (error) {
    return res.status(500).json({
      error:
        error?.name === "AbortError"
          ? "Request timed out after 120 seconds."
          : error?.message || "Unknown server error.",
      raw: error?.raw || undefined
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`God's Eye View running at http://localhost:${ PORT }`);
});