const AGENTS = [
  { key: "influencer", name: "The Influencer", role: "Aesthetic Judge", emoji: "🌟", color: "#f4c842" },
  { key: "musicLover", name: "Music Lover", role: "Taste Police", emoji: "🎧", color: "#38e4ff" },
  { key: "averageAudience", name: "Average Audience", role: "Unfiltered Mass", emoji: "👁️", color: "#ff6eb4" },
  { key: "friend", name: "Your Friend", role: "Honest Friend", emoji: "💜", color: "#39e881" }
];

let imageBase64 = null;
let imageReady = false;

const imgInput = document.getElementById("imgInput");
const uploadZone = document.getElementById("uploadZone");
const previewWrap = document.getElementById("previewWrap");
const previewImage = document.getElementById("previewImage");
const compressBadge = document.getElementById("compressBadge");
const removeBtn = document.getElementById("removeBtn");
const runBtn = document.getElementById("runBtn");
const errorBox = document.getElementById("errorBox");
const rawDebug = document.getElementById("rawDebug");
const results = document.getElementById("results");
const agentGrid = document.getElementById("agentGrid");
const summaryCard = document.getElementById("summaryCard");

imgInput.addEventListener("change", handleImageSelect);
removeBtn.addEventListener("click", removeImage);
runBtn.addEventListener("click", runAnalysis);

async function handleImageSelect(event) {
  const file = event.target.files?.[ 0 ];
  if (!file) return;

  if (file.size > 5 * 1024 * 1024) {
    showError("Max 5 MB please.");
    imgInput.value = "";
    return;
  }

  clearError();
  imageBase64 = null;
  imageReady = false;
  compressBadge.style.display = "block";

  const reader = new FileReader();

  reader.onload = (ev) => {
    const src = ev.target?.result;
    if (!src) {
      compressBadge.style.display = "none";
      showError("Could not read image.");
      return;
    }

    previewImage.src = src;
    uploadZone.style.display = "none";
    previewWrap.style.display = "block";

    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 380;
        let { width, height } = img;

        if (width > MAX) {
          height = Math.round((height * MAX) / width);
          width = MAX;
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        imageBase64 = canvas.toDataURL("image/jpeg", 0.58).split(",")[ 1 ];
        imageReady = true;
        compressBadge.style.display = "none";
      } catch {
        imageBase64 = null;
        imageReady = false;
        compressBadge.style.display = "none";
        showError("Image processing failed.");
      }
    };

    img.onerror = () => {
      imageBase64 = null;
      imageReady = false;
      compressBadge.style.display = "none";
      showError("Invalid image file.");
    };

    img.src = src;
  };

  reader.onerror = () => {
    compressBadge.style.display = "none";
    showError("Could not read image.");
  };

  reader.readAsDataURL(file);
}

function removeImage() {
  imageBase64 = null;
  imageReady = false;
  imgInput.value = "";
  previewWrap.style.display = "none";
  uploadZone.style.display = "block";
  previewImage.src = "";
  compressBadge.style.display = "none";
}

async function runAnalysis() {
  clearError();
  rawDebug.style.display = "none";
  rawDebug.textContent = "";
  results.classList.remove("show");

  const song = document.getElementById("song").value.trim();
  const caption = document.getElementById("caption").value.trim();
  const context = document.getElementById("context").value.trim();

  if (!imageBase64 && !song) {
    showError("Upload a photo or add a song title to continue.");
    return;
  }

  if (imgInput.files[ 0 ] && !imageReady) {
    showError("Image is still compressing — wait a second and try again.");
    return;
  }

  setLoading(true);

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        imageBase64,
        song,
        caption,
        context
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (data?.raw) {
        rawDebug.textContent =
          typeof data.raw === "string"
            ? data.raw
            : JSON.stringify(data.raw, null, 2);
        rawDebug.style.display = "block";
      }

      throw new Error(data?.error || `Request failed (${ response.status })`);
    }

    render(data.result, Boolean(data.cached));
  } catch (error) {
    showError(`⚠️ ${ error.message || "Something went wrong." }`);
  } finally {
    setLoading(false);
  }
}

function render(data, cached = false) {
  agentGrid.innerHTML = "";

  const comparison = data.comparison || {};
  const summary = data.summary || {};
  const comparisonSnapshot = data.comparisonSnapshot || null;

  if (comparison.acknowledged_previous_image) {
    const comparisonBanner = document.createElement("div");
    comparisonBanner.className = "acard";
    comparisonBanner.style.marginBottom = "12px";
    comparisonBanner.innerHTML = `
      <div class="ahead">
        <div class="aav">🧠</div>
        <div>
          <div class="aname">Image Memory</div>
          <div class="arole">${ cached ? "Cached exact-image result reused" : "Comparison state" }</div>
        </div>
      </div>
      <div class="abody">${ formatText(comparison.comparison_summary || "No prior image comparison available.") }</div>
      <div class="averd">
        same_image: ${ comparison.same_image ? "yes" : "no" } ·
        similar_image: ${ comparison.similar_image ? "yes" : "no" } ·
        metadata_changed: ${ comparison.metadata_changed ? "yes" : "no" } ·
        similarity_distance: ${ comparison.similarity_distance ?? "n/a" }
      </div>
    `;
    agentGrid.appendChild(comparisonBanner);
  }

  AGENTS.forEach((agent, index) => {
    const item = data[ agent.key ];
    if (!item) return;

    const attrs = item.attributes || {};
    const scorePercent = Number(item.scorePercent ?? 0);

    const specialistSection =
      agent.key === "musicLover"
        ? renderSongSuggestions(item.songSuggestions || [])
        : agent.key === "influencer"
          ? renderCaptionSuggestions(item.captionSuggestions || [])
          : "";

    const card = document.createElement("div");
    card.className = "acard";
    card.style.cssText = `--ac3:${ agent.color }; animation-delay:${ index * 0.08 }s`;

    card.innerHTML = `
      <div class="aglow"></div>
      <div class="ahead">
        <div class="aav">${ agent.emoji }</div>
        <div>
          <div class="aname">${ escapeHtml(agent.name) }</div>
          <div class="arole">${ escapeHtml(agent.role) } · Independent score: ${ scorePercent }%</div>
        </div>
      </div>

      ${ renderAgentScoreHeader(item) }

      <div class="abody">${ formatText(item.reaction || "") }</div>
      <div class="averd">${ formatText(item.verdict || "") }</div>

      ${ renderWhyScoreChanged(item) }
      ${ specialistSection }
      ${ renderScoreBreakdown(item.scoreBreakdown || {}) }

      <div class="iblk" style="margin-top:12px;">
        <div class="ilbl">Attribute Scores</div>
        ${ renderAttributes(attrs) }
      </div>
    `;

    agentGrid.appendChild(card);
  });

  const overallPercent = clamp(summary.likeliness, 0, 100);
  const confidence = clamp(summary.confidence, 0, 100);
  const overall10 = Number(summary.overallRating10 ?? 0);
  const scoreColor = overallPercent >= 70 ? "#39e881" : overallPercent >= 45 ? "#f4c842" : "#ff6eb4";
  const audienceShort = (summary.expectedViewers || "").split(" ").slice(0, 3).join(" ");

  summaryCard.innerHTML = `
    <div class="sh">⚡ God's Eye View</div>

    <div class="mrow">
      <div class="met">
        <div class="mv" style="color:${ scoreColor }">${ overallPercent }%</div>
        <div class="ml">Overall Score</div>
      </div>
      <div class="met">
        <div class="mv" style="color:var(--ac)">${ confidence }%</div>
        <div class="ml">Confidence</div>
      </div>
      <div class="met">
        <div class="mv" style="font-size:12px;padding-top:8px;color:#38e4ff">${ escapeHtml(audienceShort || "—") }…</div>
        <div class="ml">Audience</div>
      </div>
    </div>

    <div class="iblk">
      <div class="ilbl">Overall Aggregate</div>
      <div class="ins">${ escapeHtml(overall10.toFixed(1)) }/10 (${ escapeHtml(summary.consensusNote || "based on all 4 agents") })</div>
    </div>

    ${ renderOverallComparison(summary, comparisonSnapshot) }

    ${ comparison.acknowledged_previous_image
      ? `
    <div class="iblk">
      <div class="ilbl">Comparison Summary</div>
      <div class="ins">${ formatText(comparison.comparison_summary || "—") }</div>
    </div>
    `
      : ""
    }

    <div class="iblk">
      <div class="ilbl">Why The Overall Score Changed</div>
      <div class="ins">${ formatText(summary.overallScoreChangeReason || "No prior score context to compare yet.") }</div>
    </div>

    <div class="iblk">
      <div class="ilbl">Expected Viewers</div>
      <div class="ival">${ formatText(summary.expectedViewers || "—") }</div>
    </div>

    <div class="iblk">
      <div class="ilbl">Agent Interactions</div>
      ${ Array.isArray(summary.agentInteractions) && summary.agentInteractions.length
      ? summary.agentInteractions
        .map(
          (item) => `
            <div class="iitem">
              <div class="idot"></div>
              <span>${ formatText(item) }</span>
            </div>
          `
        )
        .join("")
      : '<div class="ival">—</div>'
    }
    </div>

    <div class="iblk">
      <div class="ilbl">Core Truth</div>
      <div class="ins">${ formatText(summary.bitterTruth || "—") }</div>
    </div>

    <div class="iblk">
      <div class="ilbl">Final Decision</div>
      <div class="ins">${ formatText(summary.finalDecision || "—") }</div>
    </div>

    ${ renderDebateLayer(data.debateLayer || {}) }
  `;

  results.classList.add("show");

  setTimeout(() => {
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 80);
}

function renderAgentScoreHeader(item) {
  const current = Number(item.scorePercent ?? 0);
  const previous = item.previousScorePercent;
  const delta = item.scoreDelta;

  if (previous == null || delta == null) {
    return `
      <div class="iblk">
        <div class="ilbl">Before vs After</div>
        <div class="ins">No prior score available for this agent yet.</div>
      </div>
    `;
  }

  const sign = delta > 0 ? "+" : "";
  const label =
    delta > 0 ? "improved" : delta < 0 ? "dropped" : "stayed the same";

  return `
    <div class="iblk">
      <div class="ilbl">Before vs After</div>
      <div class="ins">
        Before: ${ escapeHtml(String(previous)) }% → After: ${ escapeHtml(String(current)) }% 
        (${ sign }${ escapeHtml(String(delta)) }% · ${ escapeHtml(label) })
      </div>
    </div>
  `;
}

function renderWhyScoreChanged(item) {
  return `
    <div class="iblk">
      <div class="ilbl">Why This Score Changed</div>
      <div class="ins">${ formatText(item.scoreChangeReason || "No prior context, so no score-change explanation yet.") }</div>
    </div>
  `;
}

function renderOverallComparison(summary, comparisonSnapshot) {
  const current = summary.likeliness;
  const prev = summary.previousOverallPercent;
  const delta = summary.overallDelta;

  if (prev == null || delta == null) {
    return `
      <div class="iblk">
        <div class="ilbl">Before vs After Mode</div>
        <div class="ins">No previous overall score available yet.</div>
      </div>
    `;
  }

  const sign = delta > 0 ? "+" : "";
  const label =
    delta > 0 ? "improved" : delta < 0 ? "dropped" : "stayed stable";

  return `
    <div class="iblk">
      <div class="ilbl">Before vs After Mode</div>
      <div class="ins">
        Previous overall: ${ escapeHtml(String(prev)) }% → Current overall: ${ escapeHtml(String(current)) }% 
        (${ sign }${ escapeHtml(String(delta)) }% · ${ escapeHtml(label) })
      </div>
      ${ comparisonSnapshot
      ? `<div class="ins" style="margin-top:10px;">
              Previous final decision: ${ formatText(comparisonSnapshot.finalDecision || "—") }
            </div>`
      : ""
    }
    </div>
  `;
}

function renderScoreBreakdown(breakdown) {
  const rows = [
    [ "attention_grabbing", breakdown.attention_grabbing, false ],
    [ "aesthetic_quality", breakdown.aesthetic_quality, false ],
    [ "authenticity", breakdown.authenticity, false ],
    [ "confidence", breakdown.confidence, false ],
    [ "relatability", breakdown.relatability, false ],
    [ "good_lighting", breakdown.good_lighting, false ],
    [ "hairstyle_quality", breakdown.hairstyle_quality, false ],
    [ "cringe_penalty", breakdown.cringe_penalty, true ],
    [ "hairstyle_penalty", breakdown.hairstyle_penalty, true ]
  ];

  return `
    <div class="iblk" style="margin-top:12px;">
      <div class="ilbl">Score Breakdown Bars</div>
      ${ rows
      .map(([ label, value, isPenalty ]) => renderBreakdownBar(label, value, isPenalty))
      .join("") }
    </div>
  `;
}

function renderBreakdownBar(label, rawValue, isPenalty = false) {
  const value = Number(rawValue || 0);
  const abs = Math.min(Math.abs(value), 100);
  const color = isPenalty ? "#ff6b8a" : "#9f6bff";

  return `
    <div style="margin:10px 0;">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
        <span>${ escapeHtml(label) }</span>
        <span>${ value > 0 ? "+" : "" }${ escapeHtml(String(value)) }</span>
      </div>
      <div style="width:100%;height:10px;border-radius:999px;background:rgba(255,255,255,.06);overflow:hidden;">
        <div style="width:${ abs }%;height:100%;background:${ color };border-radius:999px;"></div>
      </div>
    </div>
  `;
}

function renderAttributes(attrs) {
  const rows = [
    [ "attention_grabbing", attrs.attention_grabbing ],
    [ "aesthetic_quality", attrs.aesthetic_quality ],
    [ "authenticity", attrs.authenticity ],
    [ "confidence", attrs.confidence ],
    [ "relatability", attrs.relatability ],
    [ "good_lighting", attrs.good_lighting ],
    [ "hairstyle_quality", attrs.hairstyle_quality ],
    [ "cringe_risk", attrs.cringe_risk ]
  ];

  return rows
    .map(([ label, value ]) => {
      const percent = Math.round((Number(value) || 0) * 100);
      return `
        <div class="iitem">
          <div class="idot"></div>
          <span><strong>${ escapeHtml(label) }</strong>: ${ percent }%</span>
        </div>
      `;
    })
    .join("");
}

function renderSongSuggestions(suggestions) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return `
      <div class="iblk" style="margin-top:12px;">
        <div class="ilbl">Song Recommendation</div>
        <div class="ins">Current song is good enough, so no replacement songs are being pushed.</div>
      </div>
    `;
  }

  return `
    <div class="iblk" style="margin-top:12px;">
      <div class="ilbl">Top 3 Better Song Fits</div>
      ${ suggestions
      .map(
        (item) => `
            <div class="iitem">
              <div class="idot"></div>
              <span>${ formatText(item) }</span>
            </div>
          `
      )
      .join("") }
    </div>
  `;
}

function renderCaptionSuggestions(suggestions) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return `
      <div class="iblk" style="margin-top:12px;">
        <div class="ilbl">Caption Recommendation</div>
        <div class="ins">Current caption already works, so no replacement captions are being suggested.</div>
      </div>
    `;
  }

  return `
    <div class="iblk" style="margin-top:12px;">
      <div class="ilbl">Top 3 Better Captions</div>
      ${ suggestions
      .map(
        (item) => `
            <div class="iitem">
              <div class="idot"></div>
              <span>${ formatText(item) }</span>
            </div>
          `
      )
      .join("") }
    </div>
  `;
}

function renderDebateLayer(debateLayer) {
  const debate = Array.isArray(debateLayer.debate) ? debateLayer.debate : [];
  const convincing = Array.isArray(debateLayer.convincing) ? debateLayer.convincing : [];
  const conclusion = debateLayer.conclusion || {};

  return `
    <div class="iblk">
      <div class="ilbl">Debate Layer</div>
      <details style="background:rgba(0,0,0,.22);border-radius:12px;padding:14px;">
        <summary style="cursor:pointer;font-weight:600;">Show chat-style debate, convincing, and conclusion</summary>

        <div style="margin-top:14px;">
          <div class="ilbl">1) Debate</div>
          ${ debate.length
      ? debate
        .map(
          (item) => `
                <div style="
                  margin:10px 0;
                  padding:12px 14px;
                  border-radius:14px;
                  background:rgba(255,255,255,.04);
                  border-left:3px solid ${ getSpeakerColor(item.speaker) };
                ">
                  <div style="font-size:12px;opacity:.75;margin-bottom:6px;">
                    Round ${ escapeHtml(String(item.round)) } ·
                    <strong>${ escapeHtml(item.speaker) }</strong>
                    → ${ escapeHtml(item.replyingTo) } ·
                    ${ escapeHtml(item.stance) }
                  </div>
                  <div style="line-height:1.6;">${ formatText(item.message) }</div>
                </div>
              `
        )
        .join("")
      : '<div class="ins">No debate returned.</div>'
    }

          <div class="ilbl" style="margin-top:14px;">2) Convincing</div>
          ${ convincing.length
      ? convincing
        .map(
          (item) => `
                <div style="
                  margin:10px 0;
                  padding:12px 14px;
                  border-radius:14px;
                  background:rgba(255,255,255,.04);
                  border-left:3px solid ${ getSpeakerColor(item.speaker) };
                ">
                  <div style="font-size:12px;opacity:.75;margin-bottom:6px;">
                    <strong>${ escapeHtml(item.speaker) }</strong> · changedMind: ${ escapeHtml(item.changedMind) }
                  </div>
                  <div style="line-height:1.6;">${ formatText(item.because) }</div>
                </div>
              `
        )
        .join("")
      : '<div class="ins">No convincing phase returned.</div>'
    }

          <div class="ilbl" style="margin-top:14px;">3) Conclusion</div>
          <div class="ins">
            <strong>Consensus:</strong> ${ formatText(conclusion.consensusSummary || "—") }<br><br>
            <strong>Final decision:</strong> ${ formatText(conclusion.finalDecision || "—") }<br><br>
            <strong>Why:</strong> ${ formatText(conclusion.why || "—") }
          </div>
        </div>
      </details>
    </div>
  `;
}

function getSpeakerColor(speaker = "") {
  const s = String(speaker).toLowerCase();
  if (s.includes("influencer")) return "#f4c842";
  if (s.includes("music")) return "#38e4ff";
  if (s.includes("average")) return "#ff6eb4";
  if (s.includes("friend")) return "#39e881";
  return "#9f6bff";
}

function setLoading(isLoading) {
  runBtn.disabled = isLoading;
  runBtn.innerHTML = isLoading
    ? '<span class="spin"></span>Agents analyzing…'
    : "✦ Activate Swarm Intelligence";
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.style.display = "block";
}

function clearError() {
  errorBox.textContent = "";
  errorBox.style.display = "none";
}

function clamp(value, min, max) {
  const num = Number(value) || 0;
  return Math.min(max, Math.max(min, num));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatText(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}