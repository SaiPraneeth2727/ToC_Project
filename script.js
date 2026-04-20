"use strict";

// ─────────────────────────────────────────────
//  SVG NAMESPACE
// ─────────────────────────────────────────────
const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
}

// ─────────────────────────────────────────────
//  GLOBAL STATE
// ─────────────────────────────────────────────
let eduStep = 0;
let eduDFA = null;
let eduNFA = null;
let sbDFA = null;

// ─────────────────────────────────────────────
//  TAB MANAGEMENT
// ─────────────────────────────────────────────
function switchTab(tab) {
    const modes = ["edu", "sandbox", "min"];
    const sections = {
        edu: document.getElementById("mode-edu"),
        sandbox: document.getElementById("mode-sandbox"),
        min: document.getElementById("mode-min")
    };
    const buttons = {
        edu: document.getElementById("tab-btn-edu"),
        sandbox: document.getElementById("tab-btn-sandbox"),
        min: document.getElementById("tab-btn-min")
    };

    // Hide all sections, deactivate all buttons
    for (const m of modes) {
        sections[m].classList.add("hidden");
        buttons[m].classList.remove("active");
    }

    // Show selected
    sections[tab].classList.remove("hidden");
    buttons[tab].classList.add("active");

    // Per-tab initialization
    if (tab === "edu") {
        eduStep = 0;
        renderEduStep();
    } else if (tab === "sandbox") {
        document.getElementById("sb-error").classList.add("hidden");
        sbDFA = null;
        document.getElementById("sb-test-input").value = "";
        const badge = document.getElementById("sb-test-badge");
        badge.textContent = "Idle";
        badge.className = "badge badge-idle text-[0.65rem] min-w-[72px] justify-center";
    } else if (tab === "min") {
        document.getElementById("min-error").classList.add("hidden");
    }
}

// ═════════════════════════════════════════════
//  PHASE 1 — DATA PARSING & SANITIZATION
// ═════════════════════════════════════════════
const EPSILON_NAMES = new Set(["eps", "epsilon", "ε"]);

function sanitizeSymbol(raw) {
    let s = raw.trim();
    if (s === "' '" || s === '" "' || s.toLowerCase() === "space") return "␣";
    if (s === " ") return "␣";
    return s;
}

function parseNFA(rawText) {
    // Step 1 — Strip carriage returns and zero-width characters
    let text = rawText
        .replace(/\r/g, "")
        .replace(/[\u200B\u200C\u200D\uFEFF]/g, "");

    const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("#") && !l.startsWith("//"));

    let startState = null;
    const acceptStates = new Set();
    const rawTransitions = [];
    const allStates = new Set();

    for (const line of lines) {
        // start: ...
        if (/^start\s*:/i.test(line)) {
            startState = line.replace(/^start\s*:\s*/i, "").trim();
            allStates.add(startState);
            continue;
        }
        // accept: ...
        if (/^accept\s*:/i.test(line)) {
            line.replace(/^accept\s*:\s*/i, "").split(",").map(s => s.trim()).filter(Boolean)
                .forEach(s => { acceptStates.add(s); allStates.add(s); });
            continue;
        }

        // Transition formats:  q0, a, q1  OR  q0 -a-> q1
        let m;
        if ((m = line.match(/^(\S+)\s*-\s*(.+?)\s*->\s*(\S+)$/))) {
            const [, from, sym, to] = m;
            allStates.add(from); allStates.add(to);
            rawTransitions.push({ from, symbol: sanitizeSymbol(sym), to });
        } else if ((m = line.match(/^(\S+)\s*,\s*(.+?)\s*,\s*(\S+)$/))) {
            const [, from, sym, to] = m;
            allStates.add(from); allStates.add(to);
            rawTransitions.push({ from, symbol: sanitizeSymbol(sym), to });
        }
    }

    // Step 4 — Max 10 states validation
    if (allStates.size > 10) {
        throw new Error("Error: Maximum limit of 10 NFA states exceeded to prevent memory overflow.");
    }
    if (!startState) throw new Error("Error: No start state defined. Add a line: start: q0");
    if (acceptStates.size === 0) throw new Error("Error: No accept states defined. Add a line: accept: q1");

    // Build NFA graph and extract alphabet Σ
    const graph = {};   // graph[state][symbol] = Set<states>
    const alphabet = new Set();

    for (const s of allStates) graph[s] = {};

    for (const t of rawTransitions) {
        const isEps = EPSILON_NAMES.has(t.symbol.toLowerCase());
        const sym = isEps ? "ε" : t.symbol;

        // Step 3 — Only non-epsilon, non-empty symbols enter Σ
        if (!isEps && sym.length > 0) alphabet.add(sym);

        if (!graph[t.from][sym]) graph[t.from][sym] = new Set();
        graph[t.from][sym].add(t.to);
    }

    return {
        states: allStates,
        startState,
        acceptStates,
        graph,
        alphabet: [...alphabet].sort()
    };
}

// ═════════════════════════════════════════════
//  PHASE 2 — MATHEMATICAL ENGINE
// ═════════════════════════════════════════════

/** Recursively find all states reachable via ε-transitions */
function getEpsilonClosure(stateSet, graph) {
    const closure = new Set(stateSet);
    const stack = [...stateSet];
    while (stack.length > 0) {
        const cur = stack.pop();
        const eps = graph[cur]?.["ε"];
        if (eps) {
            for (const t of eps) {
                if (!closure.has(t)) { closure.add(t); stack.push(t); }
            }
        }
    }
    return closure;
}

/** Iterate through EVERY state in the set, union all targets for symbol */
function move(stateSet, symbol, graph) {
    const result = new Set();
    for (const q of stateSet) {
        const targets = graph[q]?.[symbol];
        if (targets) { for (const t of targets) result.add(t); }
    }
    return result;
}

function setKey(s) { return [...s].sort().join(","); }

function toBase26(n) {
    let r = "";
    let v = n;
    do {
        r = String.fromCharCode(65 + (v % 26)) + r;
        v = Math.floor(v / 26) - 1;
    } while (v >= 0);
    return r;
}

/** Full Powerset (Subset) Construction */
function subsetConstruct(nfa) {
    const { startState, acceptStates, graph, alphabet } = nfa;

    const initClosure = getEpsilonClosure(new Set([startState]), graph);
    const initKey = setKey(initClosure);

    const dfaMap = new Map();   // key → { name, nfaSet, isAccept }
    const dfaTrans = [];        // { from, symbol, to }
    const queue = [];
    let counter = 0;
    let needDead = false;

    // Register start DFA state
    const startName = toBase26(counter++);
    dfaMap.set(initKey, {
        name: startName,
        nfaSet: initClosure,
        isAccept: [...initClosure].some(s => acceptStates.has(s))
    });
    queue.push(initKey);

    while (queue.length > 0) {
        const curKey = queue.shift();
        const cur = dfaMap.get(curKey);

        for (const sym of alphabet) {
            const moved = move(cur.nfaSet, sym, graph);
            const target = getEpsilonClosure(moved, graph);

            if (target.size === 0) {
                // → Dead State ∅
                dfaTrans.push({ from: cur.name, symbol: sym, to: "∅" });
                needDead = true;
            } else {
                const tKey = setKey(target);
                if (!dfaMap.has(tKey)) {
                    const name = toBase26(counter++);
                    dfaMap.set(tKey, {
                        name,
                        nfaSet: target,
                        isAccept: [...target].some(s => acceptStates.has(s))
                    });
                    queue.push(tKey);
                }
                dfaTrans.push({ from: cur.name, symbol: sym, to: dfaMap.get(tKey).name });
            }
        }
    }

    // Dead state ∅ with self-loop for every symbol
    if (needDead) {
        for (const sym of alphabet) {
            dfaTrans.push({ from: "∅", symbol: sym, to: "∅" });
        }
    }

    // Build state list
    const stateList = [];
    for (const [, val] of dfaMap) {
        stateList.push({
            name: val.name,
            nfaStates: [...val.nfaSet].sort(),
            isAccept: val.isAccept,
            isStart: val.name === startName,
            isDead: false
        });
    }
    if (needDead) {
        stateList.push({
            name: "∅",
            nfaStates: [],
            isAccept: false,
            isStart: false,
            isDead: true
        });
    }

    return {
        states: stateList,
        transitions: dfaTrans,
        alphabet,
        startState: startName
    };
}

// ═════════════════════════════════════════════
//  DFA STRING SIMULATION
// ═════════════════════════════════════════════
function simulateDFA(dfa, input) {
    if (!dfa) return { accepted: false, trace: [], final: null };
    // Build lookup
    const lookup = {};
    for (const t of dfa.transitions) lookup[t.from + "|" + t.symbol] = t.to;

    let cur = dfa.startState;
    const trace = [cur];
    const symbols = [...input].map(ch => ch === " " ? "␣" : ch);

    for (const sym of symbols) {
        cur = lookup[cur + "|" + sym] || "∅";
        trace.push(cur);
    }

    const stateObj = dfa.states.find(s => s.name === cur);
    return {
        accepted: stateObj ? stateObj.isAccept : false,
        trace,
        final: cur
    };
}

// ═════════════════════════════════════════════
//  PHASE 3 — SVG RENDERING ENGINE
// ═════════════════════════════════════════════
const NODE_R = 25;
const VIEW_W = 1000, VIEW_H = 600;
const CX = VIEW_W / 2, CY = VIEW_H / 2;

function addMarkers(svg, id, color) {
    const defs = svg.querySelector("defs") || svg.insertBefore(svgEl("defs"), svg.firstChild);
    const mk = svgEl("marker", {
        id,
        viewBox: "0 0 14 10",
        markerWidth: 14, markerHeight: 10,
        refX: 13, refY: 5,
        orient: "auto",
        markerUnits: "userSpaceOnUse"
    });
    mk.appendChild(svgEl("path", { d: "M0,0.5 L13,5 L0,9.5Z", fill: color }));
    defs.appendChild(mk);
}

function renderDFA(dfa, svgElement, hlStates) {
    svgElement.innerHTML = "";
    const hl = hlStates || new Set();
    const { states, transitions, alphabet, startState } = dfa;
    const n = states.length;
    if (n === 0) {
        const t = svgEl("text", { x: CX, y: CY, "text-anchor": "middle", fill: "#334155", "font-family": "Inter,sans-serif", "font-size": 14 });
        t.textContent = "No states to display";
        svgElement.appendChild(t);
        return;
    }

    // Markers
    const mkNorm = svgElement.id + "-mk";
    const mkHl = svgElement.id + "-mkHl";
    const mkDead = svgElement.id + "-mkDd";
    addMarkers(svgElement, mkNorm, "#60a5fa");
    addMarkers(svgElement, mkHl, "#4ade80");
    addMarkers(svgElement, mkDead, "#ef4444");

    // ── Layout: circular ──
    const layoutR = Math.min(VIEW_W, VIEW_H) * 0.34;
    const pos = {};
    if (n === 1) {
        pos[states[0].name] = { x: CX, y: CY };
    } else if (n === 2) {
        pos[states[0].name] = { x: CX - 150, y: CY };
        pos[states[1].name] = { x: CX + 150, y: CY };
    } else {
        states.forEach((s, i) => {
            const a = (2 * Math.PI * i / n) - Math.PI / 2;
            pos[s.name] = { x: CX + layoutR * Math.cos(a), y: CY + layoutR * Math.sin(a) };
        });
    }

    // ── Group transitions by (from,to) for label merging ──
    const edgeMap = new Map();
    for (const t of transitions) {
        const k = t.from + "→" + t.to;
        if (!edgeMap.has(k)) edgeMap.set(k, { from: t.from, to: t.to, labels: [] });
        edgeMap.get(k).labels.push(t.symbol);
    }

    // Detect bidirectional pairs
    const bidir = new Set();
    for (const [k, e] of edgeMap) {
        if (e.from !== e.to && edgeMap.has(e.to + "→" + e.from)) bidir.add(k);
    }

    // ── Draw edges ──
    for (const [k, e] of edgeMap) {
        const label = e.labels.filter(Boolean).join(", ");
        const p1 = pos[e.from], p2 = pos[e.to];
        if (!p1 || !p2) continue;

        const isDead = e.from === "∅" || e.to === "∅";
        const isHL = hl.has(e.from) && hl.has(e.to);
        const color = isHL ? "#4ade80" : isDead ? "#7f1d1d" : "#334155";
        const labelClr = isHL ? "#4ade80" : isDead ? "#991b1b" : "#64748b";
        const marker = isHL ? mkHl : isDead ? mkDead : mkNorm;
        const sw = isHL ? 2.2 : 1.5;

        if (e.from === e.to) {
            drawSelfLoop(svgElement, p1, label, marker, color, labelClr, sw, e.from);
        } else {
            drawEdge(svgElement, p1, p2, label, bidir.has(k), marker, color, labelClr, sw, k);
        }
    }

    // ── Start arrow ──
    if (pos[startState]) {
        const sp = pos[startState];
        // Determine incoming direction: from the left of the node or outward from center
        let ax = sp.x - 65, ay = sp.y;
        const arrowPath = svgEl("path", {
            d: `M ${ax} ${ay} L ${sp.x - NODE_R - 3} ${ay}`,
            fill: "none", stroke: "#60a5fa", "stroke-width": 2,
            "marker-end": `url(#${mkNorm})`
        });
        svgElement.appendChild(arrowPath);
        const stLabel = svgEl("text", {
            x: ax - 4, y: ay - 6,
            "text-anchor": "end", fill: "#60a5fa",
            "font-family": "'Fira Code',monospace", "font-size": 10
        });
        stLabel.textContent = "start";
        svgElement.appendChild(stLabel);
    }

    // ── Draw nodes (on top) ──
    for (const s of states) {
        if (!pos[s.name]) continue;
        drawNode(svgElement, pos[s.name], s, hl.has(s.name));
    }
}

function drawNode(svg, p, state, isHL) {
    const g = svgEl("g");
    let fill, stroke, textClr;
    if (state.isDead) { fill = "rgba(127,29,29,0.2)"; stroke = "#991b1b"; textClr = "#fca5a5"; }
    else if (isHL) { fill = "rgba(74,222,128,0.15)"; stroke = "#4ade80"; textClr = "#fff"; }
    else if (state.isAccept) { fill = "rgba(168,85,247,0.12)"; stroke = "#7c3aed"; textClr = "#d8b4fe"; }
    else { fill = "rgba(99,102,241,0.12)"; stroke = "#4f46e5"; textClr = "#a5b4fc"; }

    // Outer circle
    g.appendChild(svgEl("circle", {
        cx: p.x, cy: p.y, r: NODE_R,
        fill, stroke, "stroke-width": isHL ? 2.8 : 2
    }));
    // Accept → inner circle
    if (state.isAccept) {
        g.appendChild(svgEl("circle", {
            cx: p.x, cy: p.y, r: NODE_R - 5,
            fill: "none", stroke, "stroke-width": 1.2
        }));
    }
    // Name
    const txt = svgEl("text", {
        x: p.x, y: p.y + 1, "text-anchor": "middle", "dominant-baseline": "middle",
        fill: textClr, "font-family": "'Fira Code',monospace",
        "font-size": state.isDead ? 18 : 14, "font-weight": 600
    });
    txt.textContent = state.name;
    g.appendChild(txt);

    // NFA subset label
    if (!state.isDead && state.nfaStates && state.nfaStates.length) {
        const sub = svgEl("text", {
            x: p.x, y: p.y + NODE_R + 14, "text-anchor": "middle",
            fill: "#475569", "font-family": "'Fira Code',monospace", "font-size": 9
        });
        sub.textContent = "{" + state.nfaStates.join(",") + "}";
        g.appendChild(sub);
    }

    if (isHL) g.classList.add("node-pulse");
    svg.appendChild(g);
}

function drawEdge(svg, p1, p2, label, isBi, marker, color, labelClr, sw, key) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return;
    const ux = dx / dist, uy = dy / dist;

    // Endpoints on circle boundaries
    const sx = p1.x + ux * (NODE_R + 3), sy = p1.y + uy * (NODE_R + 3);
    const ex = p2.x - ux * (NODE_R + 3), ey = p2.y - uy * (NODE_R + 3);
    const chordLen = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2);

    // Perpendicular
    const px = -uy, py = ux;

    // Arc radius
    const arcR = isBi ? Math.max(dist * 0.6, 55) : dist * 2.5;

    // Always sweep=1 — bidirectional naturally separates
    const path = svgEl("path", {
        d: `M ${sx} ${sy} A ${arcR} ${arcR} 0 0 1 ${ex} ${ey}`,
        fill: "none", stroke: color, "stroke-width": sw,
        "marker-end": `url(#${marker})`
    });
    svg.appendChild(path);

    // Label position – perpendicular offset from midpoint
    const offset = isBi ? 22 : 14;
    const mx = (p1.x + p2.x) / 2 + px * offset;
    const my = (p1.y + p2.y) / 2 + py * offset;

    // Label background
    const estW = Math.max(label.length * 8, 20);
    svg.appendChild(svgEl("rect", {
        x: mx - estW / 2 - 4, y: my - 10,
        width: estW + 8, height: 20, rx: 5,
        fill: "#020617", opacity: 0.85
    }));
    const txt = svgEl("text", {
        x: mx, y: my + 1, "text-anchor": "middle", "dominant-baseline": "middle",
        fill: labelClr, "font-family": "'Fira Code',monospace", "font-size": 11, "font-weight": 500
    });
    txt.textContent = label;
    svg.appendChild(txt);
}

function drawSelfLoop(svg, p, label, marker, color, labelClr, sw, stateName) {
    // Direction outward from center
    let odx = p.x - CX, ody = p.y - CY;
    const od = Math.sqrt(odx * odx + ody * ody);
    if (od < 1) { odx = 0; ody = -1; } else { odx /= od; ody /= od; }

    // Two points on circle boundary separated by ~35°
    const baseAngle = Math.atan2(ody, odx);
    const spread = 0.35;
    const a1 = baseAngle - spread, a2 = baseAngle + spread;
    const sx = p.x + NODE_R * Math.cos(a1), sy = p.y + NODE_R * Math.sin(a1);
    const ex = p.x + NODE_R * Math.cos(a2), ey = p.y + NODE_R * Math.sin(a2);

    const loopR = 17;
    const path = svgEl("path", {
        d: `M ${sx} ${sy} A ${loopR} ${loopR} 0 1 1 ${ex} ${ey}`,
        fill: "none", stroke: color, "stroke-width": sw,
        "marker-end": `url(#${marker})`
    });
    svg.appendChild(path);

    // Label further outward
    const lx = p.x + odx * (NODE_R + loopR * 2 + 10);
    const ly = p.y + ody * (NODE_R + loopR * 2 + 10);
    const estW = Math.max(label.length * 7, 16);
    svg.appendChild(svgEl("rect", {
        x: lx - estW / 2 - 3, y: ly - 8,
        width: estW + 6, height: 16, rx: 4,
        fill: "#020617", opacity: 0.8
    }));
    const txt = svgEl("text", {
        x: lx, y: ly + 1, "text-anchor": "middle", "dominant-baseline": "middle",
        fill: labelClr, "font-family": "'Fira Code',monospace", "font-size": 10, "font-weight": 500
    });
    txt.textContent = label;
    svg.appendChild(txt);
}

// ═════════════════════════════════════════════
//  PHASE 4 — EDUCATIONAL MODE
// ═════════════════════════════════════════════
const EDU_NFA_TEXT = [
    "start: q0",
    "accept: q3",
    "q0, F, q1",
    "q1, eps, q2",
    "q1, ␣, q2",
    "q2, E, q3"
].join("\n");

const EDU_STEPS = [
    {
        title: "Step 0 — Initialization",
        desc: "We begin with the <strong>ε-NFA</strong> for regex <code class='text-pink-400'>F(ε | ␣)E</code>. This pattern matches <code>\"FE\"</code> (via ε) or <code>\"F E\"</code> (via space).",
        detail:
            `NFA States:  { q0, q1, q2, q3 }
Start: q0    Accept: { q3 }
Transitions:
  q0 —F→ q1
  q1 —ε→ q2     ← epsilon!
  q1 —␣→ q2     ← literal space
  q2 —E→ q3

Alphabet Σ = { E, F, ␣ }

Goal: Convert this ε-NFA into a fully
deterministic DFA using Powerset Construction.`,
        hlStates: [],
        showN: 0
    },
    {
        title: "Step 1 — Compute Initial ε-closure",
        desc: "Compute <code class='text-cyan-400'>ε-closure({q0})</code>. Since q0 has <em>no</em> outgoing ε-transitions, the closure is simply <code>{q0}</code>.",
        detail:
            `ε-closure({q0}):
  Start stack: [q0]
  Pop q0 → check ε-transitions → none
  Result: {q0}

→ Register DFA State A = {q0}
  A is the START state.
  q0 ∉ F (accept set) → A is NOT accepting.`,
        hlStates: ["A"],
        showN: 1
    },
    {
        title: "Step 2 — Process Symbol 'F' from State A",
        desc: "Compute <code class='text-cyan-400'>move({q0}, F)</code> to find all NFA states reachable from q0 via the symbol <strong>F</strong>.",
        detail:
            `Processing A = {q0} with symbol F:

  move({q0}, F):
    q0 —F→ q1   ✓
    Result: {q1}

Now we must compute ε-closure of this
result set to capture hidden transitions…`,
        hlStates: ["A"],
        showN: 1
    },
    {
        title: "Step 3 — Epsilon Expansion Detected!",
        desc: "Compute <code class='text-cyan-400'>ε-closure({q1})</code>. The epsilon transition <code>q1 → q2</code> <strong>expands</strong> the state set!",
        detail:
            `ε-closure({q1}):
  Start stack: [q1]
  Pop q1 → ε-transitions:
    q1 —ε→ q2  ← FOUND! Push q2
  Pop q2 → ε-transitions: none
  Result: {q1, q2}

THIS is the key insight of subset construction:
A single NFA input symbol can lead to MULTIPLE
states via ε-transitions. The DFA must track
the entire SET as one deterministic state.`,
        hlStates: ["A"],
        showN: 1
    },
    {
        title: "Step 4 — Register DFA State B",
        desc: "<code>{q1, q2}</code> is a <strong>new</strong> DFA state. Register it as <strong>State B</strong> and add transition <code>A —F→ B</code>.",
        detail:
            `δ(A, F) = ε-closure(move({q0}, F))
         = ε-closure({q1})
         = {q1, q2}

→ Register DFA State B = {q1, q2}
  q1 ∉ F, q2 ∉ F → B is NOT accepting.
  Add edge: A —F→ B

State B contains TWO NFA states, meaning
the DFA is now tracking both possibilities
simultaneously — true powerset behavior!`,
        hlStates: ["A", "B"],
        showN: 2
    },
    {
        title: "Step 5 — Process Symbol 'E' from State B",
        desc: "Now processing <strong>State B = {q1, q2}</strong>. Compute <code class='text-cyan-400'>move({q1, q2}, E)</code> — iterating through <em>every</em> state in the set.",
        detail:
            `Processing B = {q1, q2} with symbol E:

  move({q1, q2}, E):
    move(q1, E) = ∅       (no E-transition)
    move(q2, E) = {q3}    ✓
    Union = ∅ ∪ {q3} = {q3}

  ε-closure({q3}):
    q3 has no ε-transitions → {q3}

{q3} is a NEW state set — register it!`,
        hlStates: ["B"],
        showN: 2
    },
    {
        title: "Step 6 — Accept State Discovered! 🎉",
        desc: "DFA State <strong>C = {q3}</strong>. Since <code>q3</code> is an NFA accept state, <strong>C is a DFA accept state</strong>! The full deterministic machine is revealed.",
        detail:
            `→ Register DFA State C = {q3}
  q3 ∈ F → C IS an accepting state! ✓
  Add edge: B —E→ C

═══ Construction Complete ═══

Full DFA States:
  A = {q0}       (start)
  B = {q1, q2}
  C = {q3}       (accept) ✓
  D = {q2}
  ∅ = Dead State  (self-loops on all Σ)

The DFA accepts exactly:
  • "FE"  → A→B→C ✓  (ε path)
  • "F E" → A→B→D→C ✓ (space path)

🔍 Try the LIVE SCANNER below!`,
        hlStates: ["C"],
        showN: -1
    }
];

function initEduMode() {
    try {
        eduNFA = parseNFA(EDU_NFA_TEXT);
        eduDFA = subsetConstruct(eduNFA);
        eduStep = 0;
        renderEduStep();
    } catch (e) {
        console.error("Edu init error:", e);
    }
}

function renderEduStep() {
    const step = EDU_STEPS[eduStep];
    const totalSteps = EDU_STEPS.length - 1;

    // Badge
    const badge = document.getElementById("edu-badge");
    if (eduStep === totalSteps) {
        badge.textContent = "✓ Complete";
        badge.className = "badge badge-ok";
    } else {
        badge.textContent = `Step ${eduStep}/${totalSteps}`;
        badge.className = "badge badge-info";
    }

    // Step text
    document.getElementById("edu-step-text").textContent = `Step ${eduStep} / ${totalSteps}`;

    // Dots
    const dotsEl = document.getElementById("edu-dots");
    dotsEl.innerHTML = "";
    for (let i = 0; i <= totalSteps; i++) {
        const d = document.createElement("span");
        d.className = `inline-block w-2 h-2 rounded-full transition-all duration-300 ${i === eduStep ? "bg-indigo-400 scale-125 shadow-lg shadow-indigo-400/50" :
            i < eduStep ? "bg-indigo-700" : "bg-slate-800"
            }`;
        dotsEl.appendChild(d);
    }

    // Buttons
    document.getElementById("edu-prev-btn").disabled = eduStep === 0;
    const nextBtn = document.getElementById("edu-next-btn");
    nextBtn.disabled = eduStep === totalSteps;
    nextBtn.textContent = eduStep === totalSteps ? "✓ Done" : "Next →";

    // Scanner
    const scannerBox = document.getElementById("edu-scanner-box");
    if (eduStep === totalSteps) {
        scannerBox.classList.remove("hidden");
    } else {
        scannerBox.classList.add("hidden");
        document.getElementById("edu-scanner-input").value = "";
        const sb = document.getElementById("edu-scanner-badge");
        sb.textContent = "Idle";
        sb.className = "badge badge-idle min-w-[90px] justify-center";
        document.getElementById("edu-scanner-trace").classList.add("hidden");
    }

    // Log
    const logEl = document.getElementById("edu-log");
    logEl.innerHTML = "";
    for (let i = 0; i <= eduStep; i++) {
        const s = EDU_STEPS[i];
        const entry = document.createElement("div");
        entry.className = `p-3 rounded-lg ${i === eduStep ? "glass-strong border border-indigo-500/20" : "glass opacity-60"} ${i === eduStep ? "anim-slideIn" : ""}`;

        const titleDiv = document.createElement("div");
        titleDiv.className = "text-indigo-400 font-semibold text-[0.7rem] mb-1 uppercase tracking-wider";
        titleDiv.textContent = s.title;
        entry.appendChild(titleDiv);

        const descDiv = document.createElement("div");
        descDiv.className = "text-slate-300 text-xs mb-1.5 leading-relaxed";
        descDiv.innerHTML = s.desc;
        entry.appendChild(descDiv);

        if (i === eduStep) {
            const pre = document.createElement("pre");
            pre.className = "text-[0.68rem] text-slate-400 leading-relaxed font-fira bg-black/30 rounded-md p-2.5 whitespace-pre-wrap";
            pre.textContent = s.detail;
            entry.appendChild(pre);
        }

        logEl.appendChild(entry);
    }
    logEl.scrollTop = logEl.scrollHeight;

    // SVG
    renderEduSVG();
}

function renderEduSVG() {
    if (!eduDFA) return;
    const step = EDU_STEPS[eduStep];
    const hlSet = new Set(step.hlStates);

    // Progressive reveal
    if (step.showN === 0) {
        const svgEl2 = document.getElementById("edu-svg");
        svgEl2.innerHTML = "";
        const t = svgEl("text", { x: CX, y: CY - 10, "text-anchor": "middle", fill: "#475569", "font-family": "'Fira Code',monospace", "font-size": 13 });
        t.textContent = "ε-NFA defined — begin construction →";
        svgEl2.appendChild(t);
        const t2 = svgEl("text", { x: CX, y: CY + 15, "text-anchor": "middle", fill: "#334155", "font-family": "Inter,sans-serif", "font-size": 11 });
        t2.textContent = "q0 —F→ q1 —ε→ q2 —E→ q3";
        svgEl2.appendChild(t2);
        return;
    }

    let visDFA;
    if (step.showN === -1) {
        visDFA = eduDFA;
    } else {
        const nonDead = eduDFA.states.filter(s => !s.isDead);
        const shown = nonDead.slice(0, step.showN);
        const nameSet = new Set(shown.map(s => s.name));
        const visTrans = eduDFA.transitions.filter(t => nameSet.has(t.from) && nameSet.has(t.to));
        visDFA = {
            states: shown,
            transitions: visTrans,
            alphabet: eduDFA.alphabet,
            startState: eduDFA.startState
        };
    }

    renderDFA(visDFA, document.getElementById("edu-svg"), hlSet);
}

function eduNext() { if (eduStep < EDU_STEPS.length - 1) { eduStep++; renderEduStep(); } }
function eduPrev() { if (eduStep > 0) { eduStep--; renderEduStep(); } }

// ── Live Scanner ──
function initEduScanner() {
    const inp = document.getElementById("edu-scanner-input");
    const badge = document.getElementById("edu-scanner-badge");
    const traceEl = document.getElementById("edu-scanner-trace");

    inp.addEventListener("input", () => {
        if (!eduDFA) return;
        const val = inp.value;
        if (!val.length) {
            badge.textContent = "Idle";
            badge.className = "badge badge-idle min-w-[90px] justify-center";
            traceEl.classList.add("hidden");
            renderEduSVG();
            return;
        }
        const sim = simulateDFA(eduDFA, val);
        if (sim.accepted) {
            badge.textContent = "✓ Match";
            badge.className = "badge badge-ok min-w-[90px] justify-center";
        } else {
            badge.textContent = "✗ No Match";
            badge.className = "badge badge-err min-w-[90px] justify-center";
        }
        traceEl.classList.remove("hidden");
        traceEl.textContent = "Trace: " + sim.trace.join(" → ") + (sim.accepted ? "  ✓" : "  ✗");

        // Highlight active state
        const hl = new Set([sim.final]);
        renderDFA(eduDFA, document.getElementById("edu-svg"), hl);
    });
}

// ═════════════════════════════════════════════
//  PHASE 5 — DYNAMIC SANDBOX
// ═════════════════════════════════════════════
const EXAMPLES = {
    ab_star: `# NFA for ab* (a followed by zero or more b's)
start: q0
accept: q1
q0, a, q1
q1, b, q1`,

    binary_end_0: `# NFA for binary strings ending in 0
start: q0
accept: q1
q0, 0, q0
q0, 1, q0
q0, 0, q1`,

    even_ab: `# NFA for strings with even count of a's AND even count of b's
# q0 = even-a even-b,  q1 = odd-a even-b
# q2 = even-a odd-b,   q3 = odd-a odd-b
start: q0
accept: q0
q0, a, q1
q1, a, q0
q0, b, q2
q2, b, q0
q1, b, q3
q3, b, q1
q2, a, q3
q3, a, q2`,

    ctrl_f: `# NFA for regex F(ε|␣)E
start: q0
accept: q3
q0, F, q1
q1, eps, q2
q1, ␣, q2
q2, E, q3`,

    contains_01: `# NFA for binary strings containing substring "01"
start: q0
accept: q2
q0, 0, q0
q0, 1, q0
q0, 0, q1
q1, 1, q2
q2, 0, q2
q2, 1, q2`
};

function loadExample() {
    const sel = document.getElementById("sb-select");
    const ta = document.getElementById("sb-textarea");
    if (sel.value && EXAMPLES[sel.value]) {
        ta.value = EXAMPLES[sel.value];
    }
}

function showSbError(msg) {
    const el = document.getElementById("sb-error");
    el.textContent = msg;
    el.classList.remove("hidden");
}

function runConversion() {
    const errEl = document.getElementById("sb-error");
    errEl.classList.add("hidden");
    const svg = document.getElementById("sb-svg");
    const tblBox = document.getElementById("sb-table-box");
    const info = document.getElementById("sb-state-info");

    const raw = document.getElementById("sb-textarea").value.trim();
    if (!raw) { showSbError("Please enter an NFA definition or select an example."); return; }

    try {
        const nfa = parseNFA(raw);
        sbDFA = subsetConstruct(nfa);
        renderDFA(sbDFA, svg);
        info.textContent = `${sbDFA.states.length} states · Σ = { ${sbDFA.alphabet.join(", ")} }`;
        renderTable(sbDFA, tblBox);
        // Reset test
        document.getElementById("sb-test-input").value = "";
        const tb = document.getElementById("sb-test-badge");
        tb.textContent = "Idle"; tb.className = "badge badge-idle text-[0.65rem] min-w-[72px] justify-center";
    } catch (e) {
        showSbError(e.message);
        svg.innerHTML = "";
        const t = svgEl("text", { x: CX, y: CY, "text-anchor": "middle", fill: "#ef4444", "font-family": "Inter,sans-serif", "font-size": 13 });
        t.textContent = e.message.length > 60 ? e.message.substring(0, 57) + "…" : e.message;
        svg.appendChild(t);
        tblBox.innerHTML = '<div class="text-xs text-red-400/60 text-center py-6 font-fira">Parse error</div>';
        info.textContent = "";
    }
}

function renderTable(dfa, container) {
    const { states, transitions, alphabet } = dfa;
    const lookup = {};
    for (const t of transitions) lookup[t.from + "|" + t.symbol] = t.to;

    let html = '<table class="tt w-full border-collapse"><thead><tr>';
    html += '<th class="rounded-tl-lg text-left">State</th>';
    html += '<th class="text-left text-slate-500 text-[0.65rem]">NFA Set</th>';
    for (const sym of alphabet) html += `<th>δ(·, ${esc(sym)})</th>`;
    html += '<th class="rounded-tr-lg text-emerald-400">Accept</th>';
    html += '</tr></thead><tbody>';

    for (const s of states) {
        html += '<tr>';
        html += `<td class="${s.isDead ? 'text-red-400' : 'text-indigo-300'}">`;
        if (s.isStart) html += '<span class="text-blue-400 mr-1">→</span>';
        if (s.isAccept) html += '<span class="text-purple-400 mr-1">*</span>';
        html += `${esc(s.name)}</td>`;
        html += `<td class="text-[0.65rem] text-slate-600">{${s.nfaStates.length ? esc(s.nfaStates.join(",")) : "∅"}}</td>`;
        for (const sym of alphabet) {
            const target = lookup[s.name + "|" + sym] || "—";
            const dead = target === "∅";
            html += `<td class="${dead ? 'text-red-400/70' : ''}">${esc(target)}</td>`;
        }
        html += `<td>${s.isAccept ? '<span class="text-emerald-400 font-bold">✓</span>' : '<span class="text-slate-700">✗</span>'}</td>`;
        html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
}

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// ── Sandbox test input ──
function initSbTest() {
    const inp = document.getElementById("sb-test-input");
    const badge = document.getElementById("sb-test-badge");

    inp.addEventListener("input", () => {
        if (!sbDFA) {
            badge.textContent = "No DFA";
            badge.className = "badge badge-idle text-[0.65rem] min-w-[72px] justify-center";
            return;
        }
        const val = inp.value;
        if (!val.length) {
            badge.textContent = "Idle";
            badge.className = "badge badge-idle text-[0.65rem] min-w-[72px] justify-center";
            renderDFA(sbDFA, document.getElementById("sb-svg"));
            return;
        }
        const sim = simulateDFA(sbDFA, val);
        if (sim.accepted) {
            badge.textContent = "✓ Match";
            badge.className = "badge badge-ok text-[0.65rem] min-w-[72px] justify-center";
        } else {
            badge.textContent = "✗ No Match";
            badge.className = "badge badge-err text-[0.65rem] min-w-[72px] justify-center";
        }
        const hl = new Set([sim.final]);
        renderDFA(sbDFA, document.getElementById("sb-svg"), hl);
    });
}

// ═════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ═════════════════════════════════════════════
document.addEventListener("keydown", (e) => {
    // Only in edu mode and not typing in an input
    if (document.getElementById("mode-edu").classList.contains("hidden")) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.key === "ArrowRight" || e.key === "n") eduNext();
    if (e.key === "ArrowLeft" || e.key === "p") eduPrev();
});

// ═════════════════════════════════════════════
//  PHASE 6 — DFA MINIMIZER
// ═════════════════════════════════════════════

// ── Minimizer Isolated State ──
const minDFA_ctx = {
    steps: [],
    stepIdx: -1,
    parsedDFA: null,
    minimizedDFA: null,
    method: "equivalence",
    myhillStates: null
};

const MIN_EXAMPLES = {
    ex1: `# 4-state DFA (C and D are equivalent)
start: A
accept: C, D
A, 0, B
A, 1, C
B, 0, A
B, 1, D
C, 0, B
C, 1, A
D, 0, B
D, 1, A`,
    ex2: `# 5-state DFA with unreachable state E
start: A
accept: D
A, 0, B
A, 1, C
B, 0, D
B, 1, C
C, 0, B
C, 1, D
D, 0, D
D, 1, D
E, 0, A
E, 1, B`,
    ex3: `# Already minimal 3-state DFA
start: A
accept: C
A, 0, B
A, 1, A
B, 0, C
B, 1, A
C, 0, C
C, 1, C`
};

function minDFA_loadExample() {
    const sel = document.getElementById("min-example-select");
    const ta = document.getElementById("min-textarea");
    if (sel.value && MIN_EXAMPLES[sel.value]) {
        ta.value = MIN_EXAMPLES[sel.value];
    }
}

// ── Parse DFA with strict determinism & completeness validation ──
function minDFA_parse(rawText) {
    let text = rawText.replace(/\r/g, "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
    const lines = text.split("\n").map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith("#") && !l.startsWith("//"));

    let startState = null;
    const acceptStates = new Set();
    const rawTrans = [];
    const allStates = new Set();

    for (const line of lines) {
        if (/^start\s*:/i.test(line)) {
            startState = line.replace(/^start\s*:\s*/i, "").trim();
            allStates.add(startState);
            continue;
        }
        if (/^accept\s*:/i.test(line)) {
            line.replace(/^accept\s*:\s*/i, "").split(",")
                .map(s => s.trim()).filter(Boolean)
                .forEach(s => { acceptStates.add(s); allStates.add(s); });
            continue;
        }
        let m;
        if ((m = line.match(/^(\S+)\s*,\s*(.+?)\s*,\s*(\S+)$/))) {
            const [, from, sym, to] = m;
            allStates.add(from); allStates.add(to);
            rawTrans.push({ from, symbol: sym.trim(), to });
        }
    }

    // Validation
    if (allStates.size > 20)
        throw new Error("Error: Maximum 20 states allowed to prevent O(n²) freezing.");
    if (!startState)
        throw new Error("Error: No start state defined. Add a line: start: A");
    if (acceptStates.size === 0)
        throw new Error("Error: No accept states defined. Add a line: accept: C");

    const alphabet = [...new Set(rawTrans.map(t => t.symbol))].sort();
    if (alphabet.length === 0)
        throw new Error("Error: No transitions defined.");

    // Build δ[state][symbol] and check determinism
    const delta = {};
    for (const s of allStates) delta[s] = {};

    for (const t of rawTrans) {
        if (delta[t.from][t.symbol] !== undefined) {
            throw new Error(
                `Error: Non-deterministic! State '${t.from}' has multiple transitions on symbol '${t.symbol}'.`
            );
        }
        delta[t.from][t.symbol] = t.to;
    }

    // Check completeness: δ must be total
    for (const s of allStates) {
        for (const sym of alphabet) {
            if (delta[s][sym] === undefined) {
                throw new Error(
                    `Error: Incomplete DFA! Missing transition δ(${s}, ${sym}). Every state×symbol pair must be defined.`
                );
            }
        }
    }

    return {
        states: [...allStates].sort(),
        startState,
        acceptStates,
        alphabet,
        delta
    };
}

// ── Remove unreachable states ──
function minDFA_removeUnreachable(dfa) {
    const reachable = new Set();
    const queue = [dfa.startState];
    reachable.add(dfa.startState);
    while (queue.length > 0) {
        const cur = queue.shift();
        for (const sym of dfa.alphabet) {
            const next = dfa.delta[cur][sym];
            if (next && !reachable.has(next)) {
                reachable.add(next);
                queue.push(next);
            }
        }
    }
    const removed = dfa.states.filter(s => !reachable.has(s));
    const newDelta = {};
    for (const s of reachable) newDelta[s] = { ...dfa.delta[s] };
    const newAccept = new Set([...dfa.acceptStates].filter(s => reachable.has(s)));
    return {
        states: [...reachable].sort(),
        startState: dfa.startState,
        acceptStates: newAccept,
        alphabet: dfa.alphabet,
        delta: newDelta,
        removedStates: removed
    };
}

// ── Method A: Equivalence Theorem (Partition Refinement) ──
function minDFA_computeEquivalenceSteps(dfa) {
    const steps = [];
    const { states, acceptStates, alphabet, delta } = dfa;

    const nonAccept = states.filter(s => !acceptStates.has(s)).sort();
    const accept = states.filter(s => acceptStates.has(s)).sort();

    let partitions = [];
    if (nonAccept.length > 0) partitions.push(nonAccept);
    if (accept.length > 0) partitions.push(accept);

    const partStr = (parts) => parts.map(g => "{" + g.join(",") + "}").join(", ");

    steps.push({
        title: "P\u2080 \u2014 Initial Partition",
        body: `Separate accepting and non-accepting states:\n\nAccepting:     {${accept.join(", ")}}\nNon-accepting: {${nonAccept.join(", ")}}\n\nP\u2080 = ${partStr(partitions)}`,
        color: "text-amber-400"
    });

    let round = 0;
    let stable = false;
    while (!stable) {
        round++;
        stable = true;
        const newPartitions = [];
        const splitLogs = [];

        // Map each state to its current group index
        const groupOf = {};
        partitions.forEach((g, idx) => g.forEach(s => (groupOf[s] = idx)));

        for (const group of partitions) {
            if (group.length === 1) {
                newPartitions.push(group);
                continue;
            }

            // Compute signature for each state: tuple of groupOf[δ(s,a)] for all a
            const sigMap = new Map();
            for (const s of group) {
                const sig = alphabet.map(a => groupOf[delta[s][a]]).join("|");
                if (!sigMap.has(sig)) sigMap.set(sig, []);
                sigMap.get(sig).push(s);
            }

            if (sigMap.size > 1) {
                stable = false;
                const subgroups = [...sigMap.values()].map(g => g.sort());
                newPartitions.push(...subgroups);

                const reasons = [];
                for (const [, members] of sigMap) {
                    const detail = members.map(s => {
                        const targets = alphabet.map(
                            a => `\u03B4(${s},${a})=${delta[s][a]}\u2208G${groupOf[delta[s][a]]}`
                        );
                        return "  " + s + ": " + targets.join(", ");
                    }).join("\n");
                    reasons.push(`  Subgroup {${members.join(",")}}\n${detail}`);
                }
                splitLogs.push(`{${group.join(",")}} splits because members disagree on transition targets:\n${reasons.join("\n")}`);
            } else {
                newPartitions.push(group);
            }
        }

        partitions = newPartitions.map(g => g.sort());

        if (splitLogs.length > 0) {
            steps.push({
                title: `P\u2080+${round} \u2014 Refinement Round ${round}`,
                body: `${splitLogs.join("\n\n")}\n\nP${round} = ${partStr(partitions)}`,
                color: "text-rose-400"
            });
        }

        if (stable) {
            const merged = partitions.filter(g => g.length > 1)
                .map(g => "{" + g.join(",") + "}").join(", ");
            steps.push({
                title: "Fixed Point Reached \u2714",
                body: `No groups were split in round ${round}. The partition is stable.\n\nFinal partition = ${partStr(partitions)}\n\nEquivalent state groups: ${merged || "(none \u2014 DFA was already minimal)"}`,
                color: "text-emerald-400"
            });
        }

        if (round > 50) break;
    }

    return { steps, partitions };
}

// ── Method B: Myhill-Nerode Table (Lower-Triangular) ──
function minDFA_computeMyhillSteps(dfa) {
    const steps = [];
    const { states, acceptStates, alphabet, delta } = dfa;
    const n = states.length;

    // table[i][j] for i > j: true = distinguishable (marked)
    const table = {};
    for (let i = 1; i < n; i++) {
        table[i] = {};
        for (let j = 0; j < i; j++) {
            table[i][j] = false;
        }
    }

    steps.push({
        title: "Initialize Table",
        body: `Create ${n * (n - 1) / 2} pair cells for ${n} states: ${states.join(", ")}\nAll cells start UNMARKED (assumed equivalent).`,
        color: "text-amber-400",
        tableSnapshot: JSON.parse(JSON.stringify(table)),
        newlyMarked: []
    });

    // Base case: mark pairs where one is accept and other is not
    const baseCaseMarked = [];
    const baseCaseIndices = [];
    for (let i = 1; i < n; i++) {
        for (let j = 0; j < i; j++) {
            if (acceptStates.has(states[i]) !== acceptStates.has(states[j])) {
                table[i][j] = true;
                baseCaseMarked.push(`(${states[i]}, ${states[j]})`);
                baseCaseIndices.push([i, j]);
            }
        }
    }

    steps.push({
        title: "Base Case \u2014 Accept vs Non-Accept",
        body: `Mark all pairs where exactly one state is accepting.\n\nMarked: ${baseCaseMarked.length > 0 ? baseCaseMarked.join(", ") : "(none)"}`,
        color: "text-rose-400",
        tableSnapshot: JSON.parse(JSON.stringify(table)),
        newlyMarked: baseCaseIndices
    });

    // Induction passes
    let pass = 0;
    let changed = true;
    while (changed) {
        changed = false;
        pass++;
        const passMarked = [];
        const passIndices = [];
        const passReasons = [];

        for (let i = 1; i < n; i++) {
            for (let j = 0; j < i; j++) {
                if (table[i][j]) continue;

                const si = states[i], sj = states[j];
                for (const a of alphabet) {
                    const ti = delta[si][a];
                    const tj = delta[sj][a];
                    if (ti === tj) continue;
                    let ii = states.indexOf(ti);
                    let jj = states.indexOf(tj);
                    if (ii < jj) { const tmp = ii; ii = jj; jj = tmp; }
                    if (ii > jj && table[ii][jj]) {
                        table[i][j] = true;
                        changed = true;
                        passMarked.push(`(${si}, ${sj})`);
                        passIndices.push([i, j]);
                        passReasons.push(
                            `(${si}, ${sj}): \u03B4(${si},${a})=${ti}, \u03B4(${sj},${a})=${tj} \u2192 (${states[ii]}, ${states[jj]}) is marked \u2717`
                        );
                        break;
                    }
                }
            }
        }

        if (passMarked.length > 0) {
            steps.push({
                title: `Induction Pass ${pass}`,
                body: `Check each unmarked pair: do their transitions lead to a marked pair?\n\n${passReasons.join("\n")}`,
                color: "text-rose-400",
                tableSnapshot: JSON.parse(JSON.stringify(table)),
                newlyMarked: passIndices
            });
        } else {
            steps.push({
                title: `Pass ${pass} \u2014 No New Marks (Fixed Point)`,
                body: "No unmarked pair could be further distinguished. The table is complete.",
                color: "text-emerald-400",
                tableSnapshot: JSON.parse(JSON.stringify(table)),
                newlyMarked: []
            });
        }

        if (pass > 100) break;
    }

    // Extract equivalence classes via union-find
    const parent = {};
    states.forEach(s => (parent[s] = s));
    function find(x) { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
    function unite(a, b) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
    }

    for (let i = 1; i < n; i++) {
        for (let j = 0; j < i; j++) {
            if (!table[i][j]) unite(states[i], states[j]);
        }
    }

    const groups = {};
    for (const s of states) {
        const root = find(s);
        if (!groups[root]) groups[root] = [];
        groups[root].push(s);
    }
    const partitions = Object.values(groups).map(g => g.sort());

    const equivPairs = [];
    for (let i = 1; i < n; i++) {
        for (let j = 0; j < i; j++) {
            if (!table[i][j]) equivPairs.push(`(${states[i]}, ${states[j]})`);
        }
    }

    steps.push({
        title: "Equivalence Classes Extracted",
        body: `Unmarked pairs (equivalent): ${equivPairs.length > 0 ? equivPairs.join(", ") : "(none \u2014 all pairs distinguishable)"}\n\nMerge groups: ${partitions.map(g => "{" + g.join(",") + "}").join(", ")}`,
        color: "text-emerald-400",
        tableSnapshot: JSON.parse(JSON.stringify(table)),
        newlyMarked: []
    });

    return { steps, partitions, table, stateList: states };
}

// ── Build minimized DFA object compatible with renderDFA() ──
function minDFA_buildMinimized(dfa, partitions) {
    const { acceptStates, alphabet, delta, startState } = dfa;

    // Canonical name: sorted lexicographically, comma-separated
    const groupName = (group) => [...group].sort().join(",");

    const stateToGroup = {};
    for (const group of partitions) {
        const name = groupName(group);
        for (const s of group) stateToGroup[s] = name;
    }

    const newStartState = stateToGroup[startState];
    const newStates = [];
    const newTransitions = [];
    const seen = new Set();

    for (const group of partitions) {
        const name = groupName(group);
        if (seen.has(name)) continue;
        seen.add(name);

        newStates.push({
            name,
            nfaStates: group,   // reuse the field to show which states merged
            isAccept: group.some(s => acceptStates.has(s)),
            isStart: name === newStartState,
            isDead: false
        });

        // Use first member as representative for transition targets
        const rep = group[0];
        for (const sym of alphabet) {
            newTransitions.push({ from: name, symbol: sym, to: stateToGroup[delta[rep][sym]] });
        }
    }

    // Deduplicate (self-merge can produce dupes)
    const tSet = new Set();
    const dedupTrans = newTransitions.filter(t => {
        const k = `${t.from}|${t.symbol}|${t.to}`;
        if (tSet.has(k)) return false;
        tSet.add(k); return true;
    });

    return { states: newStates, transitions: dedupTrans, alphabet, startState: newStartState };
}

// ── Append a log entry to the minimizer trace ──
function minDFA_appendLog(title, body, colorClass) {
    const log = document.getElementById("min-log");
    const entry = document.createElement("div");
    entry.className = "min-log-entry glass-strong border border-white/5";

    const titleDiv = document.createElement("div");
    titleDiv.className = "log-title " + colorClass;
    titleDiv.textContent = title;
    entry.appendChild(titleDiv);

    const pre = document.createElement("pre");
    pre.textContent = body;
    entry.appendChild(pre);

    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
}

// ── Render / Update the Myhill-Nerode lower-triangular HTML table ──
function minDFA_renderMyhillTable(stateList, tableSnapshot, newlyMarked) {
    const container = document.getElementById("min-myhill-container");
    container.classList.remove("hidden");

    const n = stateList.length;
    // Columns = S1..Sn-1, Rows = S2..Sn (indices 1..n-1 vs 0..n-2)
    let html = '<table class="myhill-table"><thead><tr><th class="corner"></th>';
    for (let j = 0; j < n - 1; j++) {
        html += "<th>" + esc(stateList[j]) + "</th>";
    }
    html += "</tr></thead><tbody>";

    for (let i = 1; i < n; i++) {
        html += '<tr><th class="row-header">' + esc(stateList[i]) + "</th>";
        for (let j = 0; j < n - 1; j++) {
            if (j < i) {
                const isMarked = tableSnapshot[i] && tableSnapshot[i][j];
                const isNew = newlyMarked.some(function (pair) { return pair[0] === i && pair[1] === j; });
                let cls = isMarked ? "mn-marked" : "mn-unmarked";
                if (isNew) cls += " mn-just-marked";
                html += '<td class="' + cls + '">' + (isMarked ? "\u2717" : "\u2014") + "</td>";
            } else {
                html += '<td class="mn-empty"></td>';
            }
        }
        html += "</tr>";
    }
    html += "</tbody></table>";
    container.innerHTML = html;
}

// ── Show error in minimizer panel ──
function minDFA_showError(msg) {
    const el = document.getElementById("min-error");
    el.textContent = msg;
    el.classList.remove("hidden");
}

// ── Main entry: Start Minimization ──
function minDFA_start() {
    // Reset UI
    document.getElementById("min-error").classList.add("hidden");
    document.getElementById("min-stats").classList.add("hidden");
    const myhillBox = document.getElementById("min-myhill-container");
    myhillBox.classList.add("hidden");
    myhillBox.innerHTML = "";
    document.getElementById("min-log").innerHTML = "";

    const raw = document.getElementById("min-textarea").value.trim();
    if (!raw) {
        minDFA_showError("Please enter a DFA definition or select an example.");
        return;
    }

    let dfa;
    try {
        dfa = minDFA_parse(raw);
    } catch (e) {
        minDFA_showError(e.message);
        return;
    }

    // Remove unreachable states
    const cleaned = minDFA_removeUnreachable(dfa);
    dfa = cleaned;

    const method = document.getElementById("min-method").value;
    minDFA_ctx.method = method;
    minDFA_ctx.parsedDFA = dfa;
    minDFA_ctx.steps = [];
    minDFA_ctx.stepIdx = -1;
    minDFA_ctx.minimizedDFA = null;
    minDFA_ctx.myhillStates = null;

    // Step 0: parsed info
    const initStep = {
        title: "DFA Parsed & Validated \u2714",
        body: `States:   {${dfa.states.join(", ")}}\nAlphabet: {${dfa.alphabet.join(", ")}}\nStart:    ${dfa.startState}\nAccept:   {${[...dfa.acceptStates].join(", ")}}${cleaned.removedStates.length > 0
            ? `\n\n\u26A0 Removed unreachable: {${cleaned.removedStates.join(", ")}}`
            : "\n\n\u2713 All states are reachable."
            }`,
        color: "text-indigo-400"
    };

    if (method === "equivalence") {
        const result = minDFA_computeEquivalenceSteps(dfa);
        const minDFA = minDFA_buildMinimized(dfa, result.partitions);
        minDFA_ctx.minimizedDFA = minDFA;
        minDFA_ctx.steps = [initStep, ...result.steps, {
            title: "\u2702\uFE0F Minimized DFA Constructed",
            body: `States: ${minDFA.states.map(s =>
                s.name + (s.isAccept ? " (accept)" : "") + (s.isStart ? " (start)" : "")
            ).join(", ")}\nTransitions: ${minDFA.transitions.length}\n\nReduction: ${dfa.states.length} \u2192 ${minDFA.states.length} states${dfa.states.length === minDFA.states.length ? " (already minimal!)" : ""
                }`,
            color: "text-emerald-400",
            showGraph: true
        }];
    } else {
        const result = minDFA_computeMyhillSteps(dfa);
        minDFA_ctx.myhillStates = result.stateList;
        const minDFA = minDFA_buildMinimized(dfa, result.partitions);
        minDFA_ctx.minimizedDFA = minDFA;
        minDFA_ctx.steps = [initStep, ...result.steps, {
            title: "\u2702\uFE0F Minimized DFA Constructed",
            body: `States: ${minDFA.states.map(s =>
                s.name + (s.isAccept ? " (accept)" : "") + (s.isStart ? " (start)" : "")
            ).join(", ")}\nTransitions: ${minDFA.transitions.length}\n\nReduction: ${dfa.states.length} \u2192 ${minDFA.states.length} states${dfa.states.length === minDFA.states.length ? " (already minimal!)" : ""
                }`,
            color: "text-emerald-400",
            showGraph: true
        }];
    }

    // Enable stepping
    document.getElementById("min-next-btn").disabled = false;
    const badge = document.getElementById("min-badge");
    badge.textContent = "Step 0/" + minDFA_ctx.steps.length;
    badge.className = "badge badge-info";
    document.getElementById("min-step-text").textContent = "0 / " + minDFA_ctx.steps.length + " steps";

    // Placeholder SVG
    const svg = document.getElementById("min-svg");
    svg.innerHTML = "";
    const t = svgEl("text", {
        x: CX, y: CY, "text-anchor": "middle",
        fill: "#475569", "font-family": "'Fira Code',monospace", "font-size": 13
    });
    t.textContent = 'Click \"Next Step\" to begin\u2026';
    svg.appendChild(t);
}

// ── Step-through controller ──
function minDFA_nextStep() {
    if (minDFA_ctx.stepIdx >= minDFA_ctx.steps.length - 1) return;

    minDFA_ctx.stepIdx++;
    const step = minDFA_ctx.steps[minDFA_ctx.stepIdx];

    // Append to log
    minDFA_appendLog(step.title, step.body, step.color);

    // Myhill table update
    if (minDFA_ctx.method === "myhill" && step.tableSnapshot) {
        minDFA_renderMyhillTable(
            minDFA_ctx.myhillStates,
            step.tableSnapshot,
            step.newlyMarked || []
        );
    }

    // Final step: render the minimized DFA graph via existing renderDFA
    if (step.showGraph && minDFA_ctx.minimizedDFA) {
        renderDFA(minDFA_ctx.minimizedDFA, document.getElementById("min-svg"));

        const stats = document.getElementById("min-stats");
        stats.classList.remove("hidden");
        const orig = minDFA_ctx.parsedDFA.states.length;
        const min = minDFA_ctx.minimizedDFA.states.length;
        document.getElementById("min-stats-text").textContent =
            orig + " \u2192 " + min + " states (" +
            (orig === min ? "already minimal" : (orig - min) + " states merged") + ")";
    }

    // Update step counter
    const total = minDFA_ctx.steps.length;
    const cur = minDFA_ctx.stepIdx + 1;
    document.getElementById("min-step-text").textContent = cur + " / " + total + " steps";

    const badge = document.getElementById("min-badge");
    if (cur === total) {
        badge.textContent = "\u2714 Complete";
        badge.className = "badge badge-ok";
        document.getElementById("min-next-btn").disabled = true;
    } else {
        badge.textContent = "Step " + cur + "/" + total;
        badge.className = "badge badge-info";
    }
}

// ═════════════════════════════════════════════
//  INITIALIZATION
// ═════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
    initEduMode();
    initEduScanner();
    initSbTest();
});