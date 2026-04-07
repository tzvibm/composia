#!/usr/bin/env python3
"""
Industry Benchmark: LoCoMo (Long Conversation Memory)
https://github.com/snap-research/locomo

Standard benchmark used by Mem0 (66.9%), Zep, MemMachine.
Uses the official evaluation methodology:
- 10 conversations, ~200 QA pairs each, up to 35 sessions
- QA categories: single-hop (1), multi-hop (2), temporal (3),
  open-ended (4), unanswerable (5)
- Metrics: F1 score (official primary metric) + LLM-as-judge accuracy

Compares:
  A) Wiki-as-context (our system)
  B) Full context stuffing (all sessions in prompt)

Data: Clone https://github.com/snap-research/locomo and point
LOCOMO_DATA at data/locomo10.json, OR install `datasets` and
load from HuggingFace.
"""

import json
import os
import re
import sys
import shutil
import string
import unicodedata
from collections import Counter
from pathlib import Path

import anthropic

sys.path.insert(0, os.path.dirname(__file__))

from wiki import Wiki
from prompt_builder import PromptBuilder
from wiki_updater import WikiUpdater


# --- Config ---

LOCOMO_PATH = os.environ.get("LOCOMO_DATA", "/tmp/locomo/data/locomo10.json")
REASON_MODEL = os.environ.get("COMPOSIA_MODEL", "claude-sonnet-4-20250514")
BUILD_MODEL = os.environ.get("COMPOSIA_BUILDER_MODEL", "claude-haiku-4-5-20251001")
JUDGE_MODEL = os.environ.get("COMPOSIA_JUDGE_MODEL", "claude-haiku-4-5-20251001")
WIKI_PATH = "/tmp/composia-locomo-wiki"
MAX_CONVS = int(os.environ.get("LOCOMO_MAX_CONVS", "1"))
MAX_QA = int(os.environ.get("LOCOMO_MAX_QA", "0"))  # 0 = all

client = anthropic.Anthropic()

# QA category names from the LoCoMo paper
QA_CATEGORIES = {
    1: "single-hop",
    2: "multi-hop",
    3: "temporal",
    4: "open-ended",
    5: "unanswerable",
}


# --- Official LoCoMo F1 metric (from snap-research/locomo/task_eval/evaluation.py) ---

def normalize_answer(s):
    """Normalize answer string for F1 computation (official LoCoMo method)."""
    s = s.replace(',', "")
    def remove_articles(text):
        return re.sub(r'\b(a|an|the|and)\b', ' ', text)
    def white_space_fix(text):
        return ' '.join(text.split())
    def remove_punc(text):
        exclude = set(string.punctuation)
        return ''.join(ch for ch in text if ch not in exclude)
    def lower(text):
        return text.lower()
    return white_space_fix(remove_articles(remove_punc(lower(s))))


def f1_score(prediction, ground_truth):
    """Token-level F1 (official LoCoMo primary metric)."""
    prediction_tokens = normalize_answer(prediction).split()
    ground_truth_tokens = normalize_answer(ground_truth).split()
    common = Counter(prediction_tokens) & Counter(ground_truth_tokens)
    num_same = sum(common.values())
    if num_same == 0:
        return 0.0
    precision = num_same / len(prediction_tokens)
    recall = num_same / len(ground_truth_tokens)
    return (2 * precision * recall) / (precision + recall)


def exact_match_score(prediction, ground_truth):
    """Exact match after normalization."""
    return float(normalize_answer(prediction) == normalize_answer(ground_truth))


# --- LLM-as-judge (Mem0 methodology) ---

JUDGE_PROMPT_FACTUAL = """I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.

Question: {question}

Correct Answer: {ground_truth}

Model Response: {response}

Is the model response correct? Answer yes or no only."""

JUDGE_PROMPT_TEMPORAL = """I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.

Question: {question}

Correct Answer: {ground_truth}

Model Response: {response}

Is the model response correct? Answer yes or no only."""

JUDGE_PROMPT_UNANSWERABLE = """I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.

Question: {question}

Explanation: {ground_truth}

Model Response: {response}

Does the model correctly identify the question as unanswerable? Answer yes or no only."""


def judge_answer(question, ground_truth, response, category):
    """LLM-as-judge using LongMemEval/LoCoMo official prompts per category."""
    if category == 5:
        prompt = JUDGE_PROMPT_UNANSWERABLE
    elif category == 3:
        prompt = JUDGE_PROMPT_TEMPORAL
    else:
        prompt = JUDGE_PROMPT_FACTUAL

    try:
        resp = client.messages.create(
            model=JUDGE_MODEL,
            max_tokens=16,
            messages=[{
                "role": "user",
                "content": prompt.format(
                    question=question,
                    ground_truth=ground_truth,
                    response=response
                )
            }]
        )
        text = resp.content[0].text.strip().lower()
        return 1.0 if text.startswith("yes") else 0.0
    except Exception as e:
        print(f"    Judge error: {e}")
        return 0.0


# --- Data loading ---

def load_locomo():
    """Load LoCoMo dataset from local file or HuggingFace."""
    if os.path.exists(LOCOMO_PATH):
        with open(LOCOMO_PATH) as f:
            return json.load(f)

    # Fallback: try HuggingFace
    try:
        from datasets import load_dataset
        ds = load_dataset("Aman279/Locomo")
        return list(ds["test"])
    except Exception:
        print(f"Cannot load LoCoMo from {LOCOMO_PATH} or HuggingFace.")
        print("Clone https://github.com/snap-research/locomo and set LOCOMO_DATA.")
        sys.exit(1)


def get_conversation_turns(conv):
    """Extract all turns from all sessions in chronological order."""
    c = conv["conversation"]
    all_turns = []
    session_num = 1
    while True:
        key = f"session_{session_num}"
        date_key = f"session_{session_num}_date_time"
        if key not in c:
            break
        session_date = c.get(date_key, f"Session {session_num}")
        for turn in c[key]:
            all_turns.append({
                "speaker": turn["speaker"],
                "text": turn["text"],
                "dia_id": turn.get("dia_id", ""),
                "session": session_num,
                "session_date": session_date,
            })
        session_num += 1
    return all_turns


# --- Systems under test ---

def run_wiki_system(turns, qa_pairs):
    """Wiki-as-context: ingest conversation into wiki, then answer from wiki."""
    if Path(WIKI_PATH).exists():
        shutil.rmtree(WIKI_PATH)

    wiki = Wiki(WIKI_PATH).init()
    builder = PromptBuilder(wiki, model=BUILD_MODEL)
    updater = WikiUpdater(wiki, model=BUILD_MODEL)

    # Ingest conversation into wiki (session by session)
    print("  Ingesting into wiki...")
    current_session = None
    session_text = []

    for turn in turns:
        if turn["session"] != current_session:
            # Flush previous session
            if session_text:
                updater.update("\n".join(session_text), source="conversation")
            current_session = turn["session"]
            session_text = [f"[Session {current_session} — {turn['session_date']}]"]
        session_text.append(f"{turn['speaker']}: {turn['text']}")

    # Flush last session
    if session_text:
        updater.update("\n".join(session_text), source="conversation")

    wiki.load()
    print(f"  Wiki: {wiki.page_count()} pages")

    # Answer each question
    results = []
    for i, qa in enumerate(qa_pairs):
        q = qa["question"]
        gt = qa["answer"]
        cat = qa.get("category", 1)

        system_prompt, relevant = builder.build(q)
        resp = client.messages.create(
            model=REASON_MODEL,
            max_tokens=512,
            system=system_prompt,
            messages=[{"role": "user", "content": q}]
        )
        answer = resp.content[0].text

        f1 = f1_score(answer, gt)
        em = exact_match_score(answer, gt)
        judge = judge_answer(q, gt, answer, cat)

        results.append({
            "question": q, "ground_truth": gt, "answer": answer,
            "category": cat, "f1": f1, "em": em, "judge": judge,
        })
        cat_name = QA_CATEGORIES.get(cat, "?")
        print(f"    Q{i+1} [{cat_name}]: F1={f1:.2f} Judge={judge:.0f} | {q[:50]}...")

    return results


def run_full_context_baseline(turns, qa_pairs):
    """Baseline: stuff all conversation turns into the prompt."""
    conv_text = "\n".join(
        f"[{t['session_date']}] {t['speaker']}: {t['text']}" for t in turns
    )
    system = (
        "You are answering questions about a conversation between two people. "
        "Use ONLY the conversation provided. If the answer cannot be determined "
        "from the conversation, say so."
    )

    results = []
    for i, qa in enumerate(qa_pairs):
        q = qa["question"]
        gt = qa["answer"]
        cat = qa.get("category", 1)

        resp = client.messages.create(
            model=REASON_MODEL,
            max_tokens=512,
            system=system,
            messages=[{
                "role": "user",
                "content": f"Conversation:\n\n{conv_text}\n\nQuestion: {q}"
            }]
        )
        answer = resp.content[0].text

        f1 = f1_score(answer, gt)
        em = exact_match_score(answer, gt)
        judge = judge_answer(q, gt, answer, cat)

        results.append({
            "question": q, "ground_truth": gt, "answer": answer,
            "category": cat, "f1": f1, "em": em, "judge": judge,
        })
        cat_name = QA_CATEGORIES.get(cat, "?")
        print(f"    Q{i+1} [{cat_name}]: F1={f1:.2f} Judge={judge:.0f} | {q[:50]}...")

    return results


# --- Main ---

def print_results(name, results):
    """Print per-category and overall metrics."""
    by_cat = {}
    for r in results:
        cat = r["category"]
        if cat not in by_cat:
            by_cat[cat] = []
        by_cat[cat].append(r)

    print(f"\n  {name}:")
    total_f1, total_judge, total_n = 0, 0, 0
    for cat in sorted(by_cat.keys()):
        rs = by_cat[cat]
        avg_f1 = sum(r["f1"] for r in rs) / len(rs)
        avg_judge = sum(r["judge"] for r in rs) / len(rs)
        cat_name = QA_CATEGORIES.get(cat, f"cat-{cat}")
        print(f"    {cat_name:20s}: F1={avg_f1:.3f}  Judge={avg_judge:.3f}  (n={len(rs)})")
        total_f1 += sum(r["f1"] for r in rs)
        total_judge += sum(r["judge"] for r in rs)
        total_n += len(rs)

    print(f"    {'OVERALL':20s}: F1={total_f1/total_n:.3f}  Judge={total_judge/total_n:.3f}  (n={total_n})")
    return total_f1 / total_n, total_judge / total_n


def main():
    print("=" * 70)
    print("LoCoMo BENCHMARK (Industry Standard)")
    print("Used by: Mem0, Zep, MemMachine, Memobase")
    print(f"Reasoning model: {REASON_MODEL}")
    print(f"Builder/Judge model: {BUILD_MODEL}")
    print(f"Conversations: {MAX_CONVS} | QA limit: {'all' if MAX_QA == 0 else MAX_QA}")
    print("Metrics: Token F1 (official) + LLM-as-Judge (Mem0 methodology)")
    print("=" * 70)

    data = load_locomo()

    all_wiki = []
    all_baseline = []

    for conv_idx in range(min(MAX_CONVS, len(data))):
        conv = data[conv_idx]
        turns = get_conversation_turns(conv)
        qa_pairs = conv["qa"]
        if MAX_QA > 0:
            qa_pairs = qa_pairs[:MAX_QA]

        num_sessions = max(t["session"] for t in turns)
        print(f"\n{'='*70}")
        print(f"Conversation {conv_idx+1}/{min(MAX_CONVS, len(data))} "
              f"({conv['sample_id']})")
        print(f"  {len(turns)} turns, {num_sessions} sessions, {len(qa_pairs)} questions")

        # System A: Wiki-as-context
        print(f"\n  [A] WIKI-AS-CONTEXT")
        wiki_results = run_wiki_system(turns, qa_pairs)
        all_wiki.extend(wiki_results)

        # System B: Full context baseline
        print(f"\n  [B] FULL CONTEXT BASELINE")
        baseline_results = run_full_context_baseline(turns, qa_pairs)
        all_baseline.extend(baseline_results)

    # Final summary
    print("\n" + "=" * 70)
    print("FINAL RESULTS")
    print("=" * 70)

    wiki_f1, wiki_judge = print_results("Wiki-as-context", all_wiki)
    base_f1, base_judge = print_results("Full-context baseline", all_baseline)

    print(f"\n  {'COMPARISON':20s}: F1 diff={wiki_f1 - base_f1:+.3f}  "
          f"Judge diff={wiki_judge - base_judge:+.3f}")
    print(f"  F1 winner:    {'WIKI' if wiki_f1 > base_f1 else 'BASELINE' if base_f1 > wiki_f1 else 'TIE'}")
    print(f"  Judge winner: {'WIKI' if wiki_judge > base_judge else 'BASELINE' if base_judge > wiki_judge else 'TIE'}")

    # Save raw results
    output = {
        "config": {
            "reason_model": REASON_MODEL,
            "build_model": BUILD_MODEL,
            "judge_model": JUDGE_MODEL,
            "max_convs": MAX_CONVS,
            "max_qa": MAX_QA,
        },
        "wiki_results": all_wiki,
        "baseline_results": all_baseline,
        "summary": {
            "wiki_f1": wiki_f1, "wiki_judge": wiki_judge,
            "baseline_f1": base_f1, "baseline_judge": base_judge,
        }
    }
    out_path = "bench_locomo_results.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n  Raw results saved to {out_path}")

    # Reference scores from published papers
    print(f"\n  Reference scores (LLM-as-Judge):")
    print(f"    Mem0:        66.9%")
    print(f"    Mem0g:       68.4%")
    print(f"    OpenAI mem:  52.9%")
    print(f"    Zep:         claimed 84% (disputed, likely ~58%)")


if __name__ == "__main__":
    main()
