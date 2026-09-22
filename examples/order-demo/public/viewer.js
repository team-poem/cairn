const explanations = {
  discover:
    "The model sees the shop, chooses browser actions, and saves a scenario with a grounded order assertion.",
  replay:
    "A fresh browser follows the saved scenario. Healing is disabled and any model call would fail this recording.",
  "changed-without-heal":
    "Place order is now a link instead of a button. This run disables healing to prove the original target really breaks.",
  heal: "The model attempts a repair. The order must still satisfy the original assertions before a repaired scenario can be saved.",
  "repaired-replay":
    "Another fresh browser loads the saved repair. The repaired flow runs with healing disabled and zero model calls.",
  bug: "The order API returns 500, while the app still shows its completion screen. Healing is enabled. The original order proof must remain red.",
};
const byId = (id) => document.getElementById(id);
let manifest,
  scenario,
  selected = 0,
  frameIndex = 0,
  selectionVersion = 0;

function showFrame() {
  const frames = manifest.stages[selected].frames;
  const frame = frames[frameIndex];
  byId("frame").hidden = !frame?.image;
  byId("no-frame").hidden = Boolean(frame?.image);
  if (frame?.image) byId("frame").src = "/recording/" + frame.image;
  byId("frame-count").textContent = frames.length
    ? `${frameIndex + 1} / ${frames.length}`
    : "0 / 0";
  byId("previous").disabled = frameIndex <= 0;
  byId("next").disabled = frameIndex >= frames.length - 1;
  const target = frame?.args?.[0];
  const description =
    typeof target === "string" ? target : (target?.text ?? target?.role ?? "");
  byId("frame-caption").textContent = frame
    ? `${frame.action} ${description}${frame.error ? " · target failed" : ""}`
    : "";
  byId("frame").alt =
    `Recorded browser after ${frame?.action ?? "action"} ${description}`;
  if (scenario && frame) {
    const checks = scenario.assertions.filter((a) => !a.vacuous);
    byId("code").textContent =
      `// Actual browser action\nawait driver.${frame.action}(\n${frame.args
        .filter((arg) => arg !== null)
        .map((arg) => "  " + JSON.stringify(arg))
        .join(
          ",\n",
        )}\n);\n\n// Saved outcome checks\n${JSON.stringify(checks, null, 2)}`;
  }
}

async function selectStage(index) {
  const version = ++selectionVersion;
  selected = index;
  frameIndex = 0;
  scenario = undefined;
  const stage = manifest.stages[index];
  document.querySelectorAll(".chapter").forEach((button, i) => {
    button.classList.toggle("active", i === index);
    button.setAttribute("aria-pressed", String(i === index));
  });
  byId("explanation").textContent = explanations[stage.id] ?? stage.title;
  byId("calls").textContent = stage.observedLlmCalls ?? "Unknown";
  byId("duration").textContent = `${(stage.elapsedMs / 1000).toFixed(1)}s`;
  byId("proof").textContent = stage.verdict?.proof?.grade ?? "—";
  const failed = stage.verdict?.passed === false;
  byId("verdict").className = "verdict" + (failed ? " failure" : "");
  byId("verdict").textContent =
    stage.id === "discover"
      ? "↗ Scenario discovered and saved"
      : failed
        ? "↗ Failure detected"
        : "✓ Original goal verified";
  byId("proof-detail").textContent =
    stage.id === "discover"
      ? "Discovery saves the test. The next stage verifies it by replaying in a fresh browser."
      : failed
        ? "The run failed. Inspect the trace for the target error or failed POST /api/order assertion."
        : "The saved checks include a successful POST /api/order. Reaching a completion screen alone is not enough.";
  byId("scenario-link").href = "/recording/" + stage.scenario;
  byId("trace-link").href = "/recording/" + stage.trace;
  byId("browser-url").textContent =
    `fieldnotes / ${stage.variant === "original" ? "original UI" : stage.variant === "changed" ? "changed UI" : "broken order API"}`;
  byId("code").textContent = "Loading saved scenario…";
  showFrame();
  try {
    const response = await fetch("/recording/" + stage.scenario);
    if (!response.ok) throw new Error("Scenario unavailable");
    const loaded = await response.json();
    if (version !== selectionVersion) return;
    scenario = loaded;
    showFrame();
  } catch {
    if (version === selectionVersion)
      byId("code").textContent = "The saved scenario could not be loaded.";
  }
}

byId("previous").addEventListener("click", () => {
  frameIndex--;
  showFrame();
});
byId("next").addEventListener("click", () => {
  frameIndex++;
  showFrame();
});
try {
  const response = await fetch("/recording/manifest.json");
  if (!response.ok) throw new Error("No recording yet");
  manifest = await response.json();
  if (
    !manifest.complete ||
    manifest.stages.length !== 6 ||
    manifest.stages.some((stage) => stage.status !== "recorded")
  )
    throw new Error("The recording is incomplete");
  manifest.stages.forEach((stage, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chapter";
    const number = document.createElement("span");
    number.textContent = String(index + 1).padStart(2, "0");
    button.append(number, document.createTextNode(stage.title));
    button.addEventListener("click", () => selectStage(index));
    byId("chapters").append(button);
  });
  byId("provenance").textContent =
    `Recorded ${manifest.recordedAt.slice(0, 10)} · ${manifest.model} · engine ${manifest.engine.version} (${manifest.engine.sha256.slice(0, 8)}) · checkout ${manifest.checkoutCommit?.slice(0, 8) ?? "standalone"} · actual Chrome captures · cost not reported`;
  byId("loading").hidden = true;
  byId("experience").hidden = false;
  await selectStage(0);
} catch (error) {
  byId("loading").replaceChildren();
  const message = document.createElement("p");
  message.textContent = `${error.message}. Run npm run record from examples/order-demo to capture the real workflow. No sample results have been substituted.`;
  byId("loading").append(message);
}
