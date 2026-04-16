# Auto Review Loop: Budgeted Routing in Multi-Stage LLM Pipelines

**Started**: 2026-03-14
**Max Rounds**: 4
**Final Score**: 6/10 (Round 2)
**Final Verdict**: Almost ready for EMNLP Findings

---

## Round 1 (2026-03-14)

### Assessment (Summary)
- Score: 4/10
- Verdict: Not ready — clear reject for NeurIPS/ICML
- Recommended venue: EMNLP Findings / ACL Findings (task-specific) or MLSys (if broadened)

### Key Criticisms (ranked)
1. **Theory is the biggest liability** — submodularity claim not credible; hierarchy is not a theorem
2. **Novelty weaker than claimed** — reads as cost-sensitive routing applied to one pipeline
3. **Optimization problem may be trivial** — 3 tiers x 8 sub-tasks = hand-tuned cascade
4. **Evaluation underpowered** — ODPS-100 too small and too narrow
5. **Uncertainty taxonomy not operationally clean** — post hoc labeling risk
6. **Difficulty estimator metric wrong** — should be cost-sensitive utility, not accuracy
7. **Baselines too weak** — need learned routing, uncertainty-based router, oracle
8. **"Information-theoretic" claim is empty** — no formalization
9. **Venue fit poor for NeurIPS/ICML** — too thin for ML theory

### Reviewer Raw Response

<details>
<summary>Click to expand full reviewer response</summary>

**Critical Findings**

1. **The theory is the biggest liability.**
The submodularity claim is doing too much work and is not credible from the current formulation. End-to-end quality in a pipeline is usually not monotone-submodular because upstream errors create hard bottlenecks and later expensive calls can be complementary, not diminishing-return. The "surface → semantic → epistemic" hierarchy is also intuitive, but not a theorem.
**Minimum fix:** either prove results for a restricted surrogate objective with explicit assumptions, or drop the greedy-approximation story entirely and reframe this as an empirical budgeted-routing paper with oracle-gap/regret analysis.

2. **The novelty story is weaker than you think.**
"Allocate compute under a budget across stages" will read to many reviewers as cost-sensitive routing / adaptive computation / cascades / selective prediction / active feature acquisition, applied to one pipeline. The proposal currently renames a lot of known ideas without clearly isolating the genuinely new part.
**Minimum fix:** sharply narrow the claimed novelty to "instance-level routing inside coupled multi-stage synthesis pipelines," then compare against strong adaptive baselines, not just all-classical/all-LLM variants.

3. **The optimization problem may not actually be interesting enough.**
With only 3 tiers and only 1-2 tier-2 calls, this risks collapsing into a hand-tuned cascade with a few gates. That is useful engineering, but it is not obviously a publishable ML contribution.
**Minimum fix:** show that allocation is genuinely nontrivial with an oracle study: quantify the gap between fixed heuristics, learned routing, and optimal per-instance allocation under multiple budgets.

4. **The empirical plan is underpowered for the claims.**
ODPS-100 is a pilot dataset, not evidence for a general theory of knowledge synthesis. It is too small to support strong claims, too narrow to establish generality, and likely too small to train/evaluate ">90% accurate" difficulty estimators convincingly.
**Minimum fix:** either narrow the paper to person-profile synthesis and stop claiming generality, or add at least 2 materially different synthesis domains plus larger-scale evaluation.

5. **The uncertainty-layer taxonomy is not operationally clean.**
Many "semantic" cases require world knowledge; many "epistemic" conflicts reduce to schema/rule issues; some "surface" ambiguity explodes into entity-level reasoning. Reviewers will ask whether this is a real decomposition or post hoc labeling.
**Minimum fix:** annotate a sample with layer labels, report agreement, and show that optimal tier usage truly separates by layer. If not, present it as a heuristic design principle, not a core scientific claim.

6. **The difficulty-estimator target is wrong.**
">90% accuracy" is not the right objective. A router should optimize expected quality gain per unit cost, especially around rare expensive tier-2 decisions. High accuracy can still be useless if the mistakes are on the high-value cases.
**Minimum fix:** evaluate calibration, cost-sensitive utility, budgeted risk, and gap to oracle routing. Train the router for decision quality, not raw classification accuracy.

7. **The baseline set is not strong enough.**
Several listed baselines are weak or strawman-like for a top venue. A skeptical reviewer will ask for learned routing, uncertainty-thresholding, and stronger end-to-end synthesis baselines.
**Minimum fix:** add at least one learned policy baseline, one uncertainty-based router, one strong end-to-end LLM/tool-use baseline, and an oracle upper bound.

8. **The "information-theoretic characterization" claim is currently empty.**
Right now it reads like decorative language. There is no defined information quantity, no theorem, and no demonstrated predictive criterion for when a large LLM is needed.
**Minimum fix:** formalize an actual expected value of information / entropy-based criterion, or delete this claim.

9. **Venue-task fit is poor for NeurIPS/ICML.**
As written, this looks more like a structured NLP/IE systems paper than a core ML paper. The theory is too thin for ML theory reviewers, and the benchmark is too narrow for representation/learning reviewers.
**Minimum fix:** either broaden into a real general ML routing paper, or target a venue that values task-grounded LLM systems work.

**Bottom Line**

**Score for NeurIPS/ICML:** 4/10
Interesting idea, but currently a clear reject for a top ML venue.

**Ready for submission:** No

**Best venue:** EMNLP Findings / ACL Findings if you keep the task-specific profile-synthesis framing.
If you substantially broaden the benchmark and turn the routing piece into the real contribution, then MLSys becomes plausible.
In its current form, I would not send this to NeurIPS/ICML.

**Blunt summary**

If submitted now, this likely gets rejected for three reasons: weakly supported theory, insufficient novelty over existing routing/cost-aware inference work, and an evaluation plan that is too small and too narrow for the scope of the claims. The fastest salvage path is to stop pretending this is a theory paper, make it a rigorous empirical paper on budgeted routing in structured LLM pipelines, and either narrow the claims or greatly expand the benchmark.

</details>

### Actions Taken
1. Dropped all overreaching theory (submodularity, information-theoretic claims)
2. Reframed as empirical paper: "Budgeted Routing in Multi-Stage LLM Pipelines"
3. Sharpened novelty to 4 empirical contributions (instance-level routing, oracle gap, coupling, learned router)
4. Added oracle study as go/no-go gate experiment
5. Added strong baselines (learned router, uncertainty-threshold, GPT-4 tool-use agent, oracle)
6. Fixed router evaluation metric (cost-sensitive utility, not accuracy)
7. Expanded dataset to ODPS-500
8. Added stage coupling experiment
9. Retargeted venue to EMNLP 2026
10. Added explicit non-claims

### Status
- Continuing to Round 2

---

## Round 2 (2026-03-14)

### Assessment (Summary)
- Score: 6/10
- Verdict: Almost ready for EMNLP Findings; not ready for EMNLP main unless results are strong
- Key concern: paper depends on one narrow pipeline/domain; contribution is outcome-contingent

### Key Remaining Criticisms
1. **Still one narrow pipeline, one narrow domain** — need at least one materially different synthesis setting
2. **Contribution is outcome-contingent** — if oracle gap is small, coupling is weak, or router doesn't help, paper collapses
3. **Novelty still vulnerable** to "this is just adaptive routing with a pipeline wrapper"
4. **Stage coupling experiment could look merely descriptive** — need causal/interaction analysis, not just Tier-0-vs-Tier-2 contrast
5. **Oracle analysis bound to one specific 8-stage pipeline** — may not generalize
6. **ODPS-500 still self-created** — needs rigorous dataset card, annotation protocol, agreement stats
7. **Logistic regression router may feel methodologically thin**
8. **Model/pricing dependence** — conclusions may be transient
9. **GPT-4 agent baseline** must be fairly tuned or it backfires
10. **Human eval** needs blinded pairwise comparison + factuality audit, not vague Likert

### Reviewer Raw Response

<details>
<summary>Click to expand full reviewer response</summary>

**Score / Verdict**

**EMNLP score:** 6/10
**Verdict:** Almost for EMNLP Findings; still not ready for EMNLP main unless the actual results are unusually clean and strong.

This is a real improvement. You removed the easiest reject vectors, and the paper now has a coherent empirical center. But it is still fragile: if the oracle-gap result is modest, if coupling effects are weak, or if the dataset/methodology reads as too bespoke, the contribution collapses into "a sensible routed pipeline for one task."

**Remaining Weaknesses Ranked by Severity**

1. **The paper still depends on one narrow pipeline and one narrow domain.**
A reviewer can still say: this is an interesting profile-synthesis case study, not a broadly important empirical finding about multi-stage LLM pipelines.

2. **Your core contribution is still outcome-contingent.**
The entire paper now hinges on three empirical facts being true: large oracle gap, meaningful stage coupling, and a learned router recovering most of that gap. If any one of these is weak, the paper loses most of its reason to exist.

3. **Novelty is improved but still vulnerable.**
"Instance-level routing in coupled multi-stage pipelines" is better than before, but reviewers may still map this to adaptive routing / selective prediction / cascade control with a fixed pipeline wrapper.

4. **The stage-coupling experiment could look descriptive rather than scientifically sharp.**
If you simply compare downstream stage value under upstream Tier 0 vs Tier 2, a reviewer may say you are just observing error propagation, not discovering a new routing phenomenon.

5. **The oracle analysis may not generalize beyond your specific 8-stage design.**
Exhaustive search over 3^8 assignments is clean, but it may also advertise that the result is tightly bound to one handcrafted pipeline with a tiny action space.

6. **ODPS-500 is better, but still not obviously enough to carry a new benchmark paper.**
Because it is self-created, reviewers will probe annotation quality, leakage, source diversity, ambiguity distribution, and whether the dataset is large enough to support router learning and stable conclusions.

7. **The learned-router story may still feel too lightweight.**
A logistic regression router is good for simplicity, but it also makes the paper look methodologically thin unless the analysis is excellent.

8. **Model/pricing dependence remains a real concern.**
If your conclusions depend heavily on one cheap model, one expensive model, and one moment-in-time pricing ratio, reviewers can dismiss the findings as transient.

9. **Baseline fairness will be scrutinized.**
The GPT-4 tool-use agent baseline can backfire if it is under-tuned, over-budget, or not granted equivalent structure/tools.

10. **Human evaluation can still sink credibility.**
"Profile quality" is exactly the kind of metric that gets torn apart if the rubric, blinding, agreement, and adjudication are weak.

**Minimum Fixes**

1. Add one more materially different synthesis setting (not just company profiles — a different schema/task)
2. Make the paper explicitly conditional on go/no-go experiments; pivot story if needed
3. Avoid "first" claims unless defensible; use "we study" or "we empirically characterize"
4. Make coupling analysis causal: marginal value conditioned on upstream quality bins + interaction analysis
5. Decompose oracle gains by stage, budget, and ambiguity regime
6. Treat dataset like a benchmark artifact: annotation protocol, agreement, source stats, dataset card
7. Add one nonlinear router (GBDT) alongside logistic regression
8. Run cost-ratio sensitivity analysis + test with alternate model family
9. Match baseline budgets and affordances exactly
10. Use blinded pairwise comparison + factuality audit for human eval

**Bottom Line**

This moved from a likely top-tier reject to a plausible EMNLP paper. But it is still not robust enough that I would call it submission-ready today. If the empirical results are strong, the dataset is presented rigorously, and the claims stay disciplined, this is viable for EMNLP Findings and maybe borderline EMNLP main. If the oracle gap or coupling story is weak, it will read as a competent but narrow systems paper.

</details>

### Actions Taken
- Stop condition met (score >= 6, verdict = "Almost")
- No further implementation in this loop

### Status
- **STOPPED** — threshold met

---

## Final Summary

### Score Progression
| Round | Score | Verdict | Key Change |
|---|---|---|---|
| 1 | 4/10 | Not ready | Initial framing as theory paper |
| 2 | 6/10 | Almost | Reframed as empirical paper, dropped overreaching claims |

### Remaining Blockers for Submission
1. **Second synthesis domain** — need one more task beyond person profiles (e.g., event timeline synthesis, product knowledge cards)
2. **Strong empirical results** — oracle gap must be >10%, coupling must be measurable, router must recover >80% of gap
3. **Dataset rigor** — full annotation protocol, agreement stats, dataset card for ODPS-500
4. **Human eval protocol** — blinded pairwise comparison + factuality audit
5. **Second router** — add GBDT alongside logistic regression
6. **Cost sensitivity** — sweep pricing ratios, test with second model family
7. **Causal coupling analysis** — marginal value conditioned on upstream quality bins

### Recommended Next Steps
1. Build the TLAPS pipeline (extract from GenSearch, make standalone)
2. Annotate ODPS-200 dev set
3. Run oracle gap study — THIS IS THE GO/NO-GO GATE
4. If gap >10%: proceed with full paper
5. If gap <5%: pivot framing to "when do LLM calls add value in knowledge synthesis?" (descriptive study)
