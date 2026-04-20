# ε-NFA → DFA Converter & DFA Minimizer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Theory of Computation](https://img.shields.io/badge/Theory-Computation-blueviolet)](https://en.wikipedia.org/wiki/Theory_of_computation)

A premium, interactive web-based simulator designed for Theory of Computation (TOC) students and educators. This tool visualizes the formal transformation of Non-deterministic Finite Automata with epsilon transitions (ε-NFA) to Deterministic Finite Automata (DFA), and performs DFA minimization using state-of-the-art algorithms.

![Project Preview](https://toc-project-five.vercel.app/)

## ⚡ Main Features

- **ε-NFA to DFA Conversion**: Implements the robust **Powerset (Subset) Construction** algorithm with full $\epsilon$-closure calculations.
- **DFA Minimization**: Dual-engine support for state reduction:
  - **Method A**: Equivalence Theorem (Partitioning / Moore's Algorithm).
  - **Method B**: Myhill-Nerode Table (Table Filling Algorithm).
- **Educational Mode**: A guided, step-by-step walkthrough of the conversion process for a regex like `F(ε|␣)E`.
- **Dynamic Sandbox**: Define your own NFA using a simple text-based DSL and convert it instantly.
- **Live DFA Scanner**: Test strings against the generated machine in real-time with highlighted state tracing.
- **Advanced SVG Engine**: Custom-built visualization engine rendering optimized circular layouts, merged transition labels, and arc-based bidirectional edges.

## 🛠️ Technology Stack

- **Core**: Vanilla JavaScript (ES6+)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/) (UI Framework) & Vanilla CSS (Custom Glassmorphism)
- **Visuals**: Scalable Vector Graphics (SVG) for high-fidelity automaton graphs
- **Typography**: Inter (UI) & Fira Code (Technical Trace)

## 🚀 Getting Started

Simply open `index.html` in any modern web browser. No compilation or server environment is required.

```bash
# Clone the repository
git clone https://github.com/SaiPraneeth2727/ToC_Project.git

# Open the project
cd ToC_Project
start index.html
```

## 📝 NFA Definition Format

The sandbox accepts a simple comma-separated or arrow-based format:

```text
start: q0
accept: q2, q3

q0, a, q1
q1, eps, q2
q2 -b-> q3
```

- `start`: Define the initial state.
- `accept`: Comma-separated list of final states.
- `eps`, `epsilon`, or `ε`: Used for null transitions.

## 🧠 Key Insights

### 1. Powerset Construction
The tool handles the exponential state explosion by lazy-loading only reachable subsets. It automatically generates a **Dead State (∅)** with complete self-loops to maintain formal DFA determinism.

### 2. State Naming
DFA states are named using **Base-26 (A, B, C...)** for clarity, while the underlying NFA subsets `{q0, q1...}` are displayed as metadata for educational transparency.

### 3. Minimization Algorithms
- **Equivalence Partitioning**: Refines $\Pi$ partitions until stability is reached.
- **Myhill-Nerode**: Visualizes the (n-1)x(n-1) triangular table filling process with real-time "marking" animations.

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.

---
*Created for educational excellence in Theory of Computation.*
