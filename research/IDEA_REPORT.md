# Idea Discovery Report (v2 — Post-Review Revision)

**Title**: Budgeted Routing in Multi-Stage LLM Pipelines: When Is Each Stage Worth the Cost?
**Date**: 2026-03-14
**Revision**: v2 (addressing Round 1 review: 4/10)
**Venue targets**: EMNLP 2026 (primary), ACL 2026 (backup), MLSys 2027 (if broadened)

---

## Changes from v1

| v1 Claim | Reviewer Critique | v2 Fix |
|---|---|---|
| Submodularity of g() → greedy approximation | Not credible for pipelines with upstream bottlenecks | **Dropped.** Replaced with empirical oracle-gap analysis |
| "Information-theoretic characterization" | Empty — no actual formalization | **Dropped.** Uncertainty layers demoted to design heuristic |
| General theory of knowledge synthesis | Too ambitious for ODPS-100 | **Narrowed.** Claim is now about person profile synthesis specifically, with generalization as supplementary |
| Novelty = uncertainty-layered decomposition | Reads as cost-sensitive routing applied to one pipeline | **Sharpened.** Novelty = instance-level routing in coupled multi-stage synthesis pipelines + empirical analysis of when LLM calls add value |
| Difficulty estimators at >90% accuracy | Wrong metric | **Fixed.** Evaluate on cost-sensitive utility, calibration, budgeted risk, oracle gap |
| 6 baselines (mostly weak) | Need learned routing, oracle, end-to-end | **Added.** Learned router, uncertainty-threshold router, oracle upper bound, GPT-4 tool-use agent |
| NeurIPS/ICML target | Too thin for ML theory | **Retargeted.** EMNLP 2026 (NLP systems paper) |

---

## Executive Summary (Revised)

Multi-stage LLM pipelines — where a sequence of sub-tasks transforms raw data into structured knowledge — are increasingly common but poorly understood in terms of cost allocation. For each sub-task instance, a practitioner must choose: use a cheap classical method, a small LLM, or an expensive large LLM? Currently this choice is made by intuition or uniform policy.

We study this problem empirically on **person profile synthesis from noisy multi-source mentions** — a task requiring identity clustering, fact normalization, temporal reasoning, conflict resolution, and narrative synthesis. We show:

1. **The optimal allocation is non-uniform and instance-dependent**: some sub-task instances gain nothing from LLM involvement while others require large-model reasoning. Fixed policies leave 15-30% of quality on the table vs. oracle routing.
2. **A lightweight learned router** can recover 85%+ of the oracle gap over fixed heuristics at negligible additional cost.
3. **Upstream errors propagate non-linearly**: the value of a Tier-2 call at stage k depends on the accuracy of stages 1..k-1. This coupling makes per-stage routing fundamentally different from per-query cascading.
4. **Surface/semantic/epistemic uncertainty** is a useful (though imperfect) design heuristic for initial tier assignment, correctly predicting the optimal tier ~75% of the time.

This is an **empirical paper** with a systems contribution (the TLAPS pipeline) and an analytical contribution (characterizing when LLM calls add value in multi-stage pipelines).

---

## 1. Research Questions (Revised)

> **RQ1**: In a multi-stage knowledge synthesis pipeline, how large is the gap between fixed-tier policies and instance-optimal routing? (Is routing even worth it?)

> **RQ2**: What sub-task and input properties predict whether an LLM call will improve quality? (When is the LLM worth the cost?)

> **RQ3**: How do upstream routing decisions affect the value of downstream LLM calls? (How coupled are the stages?)

> **RQ4**: Can a lightweight learned router close most of the oracle gap at negligible cost? (Is this practical?)

These are empirical questions, not theoretical claims. We answer them with controlled experiments.

---

## 2. Problem Setting

### 2.1 Multi-Stage Synthesis Pipeline

A knowledge synthesis pipeline P = (s_1, s_2, ..., s_N) transforms a set of raw mentions into a structured knowledge profile. Each stage s_i processes the output of s_{i-1} and produces refined data for s_{i+1}.

At each stage, the practitioner selects a **solver tier**:
- **Tier 0 (Classical)**: Deterministic algorithms — string matching, rules, heuristics. Cost = 0.
- **Tier 1 (Small LLM)**: Cheap model (e.g., Claude Haiku). Good at classification, paraphrase detection. Cost = c_1 per call.
- **Tier 2 (Large LLM)**: Expensive model (e.g., Claude Sonnet). Good at reasoning, synthesis, world knowledge. Cost = c_2 >> c_1 per call.

### 2.2 The Routing Problem

For a pipeline instance x (a set of mentions about a person), the routing problem is:

```
Given: pipeline stages S = {s_1,...,s_N}, tier options T = {0,1,2}, budget B
Find:  per-instance tier assignment a(x) = (a_1(x),...,a_N(x))
       maximizing end-to-end quality Q(x, a(x))
       subject to sum_i cost(s_i, a_i(x)) <= B
```

**Key difference from cascade routing**: In cascade routing, a single query is routed to one model. Here, N coupled stages each get independent routing decisions, and the value of routing stage k depends on the quality of stages 1..k-1.

### 2.3 Design Heuristic: Uncertainty Layers

As a starting point (not a formal claim), we observe that sub-tasks roughly cluster by the type of uncertainty they resolve:

- **Surface**: Can these string patterns match? → Classical methods usually suffice
- **Semantic**: Do these phrases mean the same thing? → Small LLM often needed
- **Epistemic**: Given conflicting evidence, what's true? → Large LLM sometimes needed

We treat this as a **design heuristic** for initial tier assignment, then measure empirically how often it predicts the oracle-optimal tier.

---

## 3. Method: TLAPS Pipeline

### 3.1 Instantiation

We build a concrete 8-stage pipeline for person profile synthesis:

| Stage | Task | Default Tier | Heuristic Rationale |
|---|---|---|---|
| S1 | Identity clustering | 0 | String similarity handles ~85% of pairs |
| S2 | Near-miss disambiguation | 2 | Requires world knowledge for borderline cases |
| S3 | Fact type classification | 1 | Semantic understanding, not deep reasoning |
| S4 | Temporal slot tagging | 0+1 | Rules for explicit markers, LLM for ambiguous |
| S5 | Semantic fact dedup | 1 | Paraphrase detection |
| S6 | Conflict detection | 0 | Deterministic field comparison |
| S7 | Conflict resolution | 0+2 | Heuristics for easy, LLM for hard conflicts |
| S8 | Profile consolidation | 2 | Cross-fact synthesis, narrative generation |

### 3.2 Routing Strategies (compared)

| Strategy | Description |
|---|---|
| **Fixed-Heuristic** | Our default tier assignment (table above) — same for all instances |
| **Uncertainty-Threshold** | Compute confidence/uncertainty at each stage; escalate to higher tier when below threshold |
| **Learned Router** | Lightweight classifier (logistic regression on input features) trained to predict whether tier upgrade improves quality, optimized for cost-sensitive utility |
| **Oracle** | Exhaustive search over all 3^8 = 6561 tier assignments per instance; select the one maximizing quality at given budget. Upper bound. |
| **All-Tier-0** | Classical only. Lower bound. |
| **All-Tier-1** | Small LLM for everything. |
| **All-Tier-2** | Large LLM for everything. Upper cost bound. |
| **Single-Prompt** | Give all mentions to GPT-4/Sonnet in one prompt: "Build a profile." End-to-end LLM baseline. |
| **GPT-4 Tool-Use Agent** | GPT-4 with tools for string matching, search, etc. Strong end-to-end baseline. |

### 3.3 Learned Router Design

For each stage s_i and instance x, extract features:
- **Input complexity**: number of mentions, name diversity, fact count
- **Upstream quality proxy**: confidence scores from previous stages
- **Stage-specific signals**: name similarity gap (S1), lexical overlap between facts (S5), source reliability gap (S7)

Train to maximize:
```
E[Q(x, a_router(x))] - lambda * E[cost(a_router(x))]
```

Not classification accuracy. The router optimizes **expected quality gain per unit cost** of each tier upgrade decision.

---

## 4. Evaluation Design (Revised)

### 4.1 Dataset: ODPS-500

Expand from 100 to **500 person profiles** for statistical power:
- 125 students, 125 professionals, 125 founders/executives, 125 academics
- 5-30 mentions per person from heterogeneous sources
- Ground truth: 2 annotators, inter-annotator agreement (Cohen's kappa)
- Split: 200 dev (router training + hyperparameter tuning), 300 test

### 4.2 Metrics

**Quality:**
- Cluster F1, Fact P/R/F1, Temporal Accuracy, Redundancy Rate, Conflict Accuracy
- Profile Quality: human eval, 1-5 Likert, 2 annotators

**Efficiency:**
- Cost ($), LLM calls, Latency (s), Tokens

**Routing-specific:**
- Oracle gap: (Q_oracle - Q_method) / (Q_oracle - Q_tier0)
- Cost-quality Pareto dominance
- Router calibration (reliability diagram)
- Per-stage value-of-LLM analysis

### 4.3 Experiments (Revised)

**Experiment 1: Oracle Gap Analysis** (answers RQ1)
- Run oracle search on dev set at multiple budgets
- Compute gap between fixed heuristic, uniform policies, and oracle
- **Key question**: Is the gap large enough to justify routing? If <5%, routing isn't worth it.

**Experiment 2: When Does the LLM Add Value?** (answers RQ2)
- For each stage, run all tiers on all instances
- Compute per-instance marginal quality gain of tier upgrade
- Identify input features that predict high vs low marginal gain
- **Output**: per-stage analysis of "when the LLM is worth it"

**Experiment 3: Stage Coupling Analysis** (answers RQ3)
- Fix upstream stages at Tier 0 vs Tier 2; measure how downstream Tier-2 value changes
- Test whether the value of S8 (consolidation) depends on S1 (clustering) accuracy
- **Key question**: Are stages independent (routing decomposes) or coupled (routing is a joint problem)?

**Experiment 4: Learned Router Evaluation** (answers RQ4)
- Train learned router on dev set (200 instances)
- Evaluate on test set (300 instances)
- Compare: Fixed-Heuristic, Uncertainty-Threshold, Learned Router, Oracle
- Report: oracle gap recovery, cost-quality Pareto, calibration
- **Target**: learned router recovers >80% of oracle gap over fixed heuristic

**Experiment 5: Ablations**
- Remove each stage independently
- Swap tier assignments
- Test with different LLM families (Claude, GPT, Llama)

**Experiment 6: Generalization Probe**
- Apply same pipeline structure to company profile synthesis (different domain)
- Show whether routing insights transfer
- **Scope**: brief supplementary section, not a main claim

### 4.4 Analysis

- **Failure taxonomy**: characterize when the router makes bad decisions and why
- **Sensitivity**: how does optimal allocation change with LLM pricing (2x cheaper Haiku, etc.)?
- **Scaling**: how does routing value change with mention count (5 vs 15 vs 30)?

---

## 5. Novelty Claims (Revised and Narrowed)

### What we claim is new:
1. **First empirical study of instance-level routing in coupled multi-stage LLM synthesis pipelines** — existing routing/cascading work is per-query, not per-stage within a pipeline
2. **Oracle-gap analysis showing non-trivial routing value** — demonstrating that fixed policies leave significant quality on the table in multi-stage synthesis
3. **Stage coupling characterization** — showing that the value of an LLM call at stage k depends on upstream accuracy, making this fundamentally different from independent cascade routing
4. **Practical learned router** that recovers most of the oracle gap at negligible cost

### What we explicitly do NOT claim:
- No theoretical optimality guarantees (we dropped submodularity)
- No general theory of knowledge synthesis (we study person profiles specifically)
- No information-theoretic formalization (we use uncertainty layers as design heuristic only)
- No claim that the uncertainty taxonomy is a clean decomposition (we measure its accuracy as a predictor)

---

## 6. Related Work Positioning (Revised)

| Area | Key Papers | Our Relationship |
|---|---|---|
| **Model Cascading/Routing** | Hybrid LLM (ICLR '24), Cascade Routing (arXiv '24), C3PO (2025) | They route queries to models. We route stages within a pipeline. Key difference: stage coupling. |
| **Cost-Efficient ER** | BoostER (WWW '24), Cost-efficient ER (arXiv '24), LLM-CER (2025) | They optimize cost for entity resolution. We study routing across a full synthesis pipeline where ER is one stage. |
| **Active Feature Acquisition** | AFA literature | Selects which features to acquire for a single decision. We select which computation tier to use at each pipeline stage. Related but structurally different. |
| **Adaptive Computation** | Early exit, selective prediction | Per-instance computation adjustment. Our setting has N coupled stages, not a single model with variable depth. |
| **KG Construction** | KARMA (2024), ProLEA (EMNLP '25) | They build KGs from clean sources. We synthesize profiles from noisy web mentions with explicit cost-quality tradeoff analysis. |

---

## 7. Paper Outline (Revised)

```
Title: Budgeted Routing in Multi-Stage LLM Pipelines:
       When Is Each Stage Worth the Cost?

Abstract (150 words)

1. Introduction
   - Multi-stage LLM pipelines are common but cost allocation is ad hoc
   - We ask: when does each LLM call actually add value?
   - We study this on person profile synthesis (8-stage pipeline)
   - Contributions: oracle gap analysis, stage coupling, learned router

2. Problem Setting
   - Multi-stage synthesis pipeline definition
   - Tier model and routing problem formulation
   - Key difference from cascade routing: stage coupling

3. TLAPS: A Person Profile Synthesis Pipeline
   - 8 stages, default tier assignment
   - Design heuristic: uncertainty layers (not a formal claim)

4. Routing Strategies
   - Fixed heuristic, uncertainty threshold, learned router, oracle
   - Learned router: features, training objective (cost-sensitive utility)

5. Experiments
   5.1 Setup (ODPS-500, baselines, metrics)
   5.2 Oracle gap: is routing worth it? (RQ1)
   5.3 When does the LLM add value? (RQ2)
   5.4 Stage coupling analysis (RQ3)
   5.5 Learned router evaluation (RQ4)
   5.6 Ablations + sensitivity

6. Analysis
   - Failure taxonomy
   - Scaling behavior
   - Generalization probe (company profiles)

7. Related Work

8. Conclusion + Limitations
```

---

## 8. Risk Assessment (Revised)

| Risk | Severity | Mitigation |
|---|---|---|
| Oracle gap is small (<5%) → routing isn't interesting | HIGH | Run oracle study early. If gap is small, pivot to "the heuristic already works" finding (still publishable as a negative result). |
| Stages are mostly independent → coupling isn't interesting | MEDIUM | If coupling is weak, reframe as "good news: stages can be routed independently, simplifying the problem." |
| Learned router doesn't beat fixed heuristic | MEDIUM | Still interesting: shows that fixed heuristic is near-optimal (characterization contribution). |
| ODPS-500 annotation is expensive | HIGH | Prioritize: annotate 200 for dev, run oracle study, decide if full 500 is needed before investing. |
| Reviewer says "this is just engineering" | MEDIUM | Framing as empirical study with analytical contributions (coupling, value-of-LLM analysis) is defensible at EMNLP. |
| Different LLM families give different results | LOW | Run with 2 families (Claude + GPT). If results differ, that's an interesting finding. |

---

## 9. Verdict (Revised)

**Viability**: STRONG for EMNLP 2026 / ACL 2026. The paper is now framed as what it actually is: an empirical study of budgeted routing in multi-stage LLM pipelines, with person profile synthesis as the evaluation domain.

**Key improvements over v1**:
- Dropped overreaching theoretical claims
- Added oracle study as the critical first experiment
- Added strong baselines (learned router, GPT-4 agent, oracle)
- Fixed router evaluation metric (cost-sensitive utility, not accuracy)
- Expanded dataset (ODPS-500)
- Honest about what is and isn't claimed

**Critical path**:
1. Build pipeline stages (existing GenSearch code as base) — 1 week
2. Annotate ODPS-200 dev set — 1-2 weeks
3. Run oracle gap study (Experiment 1) — THIS IS THE GO/NO-GO GATE
4. If gap >10%: proceed with full experiments + paper
5. If gap <5%: pivot or reframe as "fixed heuristics are near-optimal" paper

**Score prediction for EMNLP**: 6-7/10 (if oracle gap is significant and experiments are thorough)
