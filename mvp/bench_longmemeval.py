#!/usr/bin/env python3
"""
Industry Benchmark: LongMemEval (ICLR 2025)
https://github.com/xiaowu0162/LongMemEval

500 curated questions across 5 long-term memory capabilities:
  - Information extraction (single-session-user, single-session-assistant)
  - Preference recall (single-session-preference)
  - Multi-session reasoning (multi-session)
  - Temporal reasoning (temporal-reasoning)
  - Knowledge updates (knowledge-update)

Uses the official LongMemEval evaluation methodology:
  - LLM-as-judge with task-specific prompts (from their evaluate_qa.py)
  - Accuracy = percentage of "yes" from judge

Data: Clone https://github.com/xiaowu0162/LongMemEval and download
the data files, OR load from HuggingFace.
"""

import json
import os
import re
import sys
import shutil
from pathlib import Path

import anthropic

sys.path.insert(0, os.path.dirname(__file__))

from wiki import Wiki
from prompt_builder import PromptBuilder
from wiki_updater import WikiUpdater


# --- Config ---

LONGMEMEVAL_PATH = os.environ.get(
    "LONGMEMEVAL_DATA",
    "/tmp/longmemeval/data/longmemeval_oracle.json"
)
REASON_MODEL = os.environ.get("COMPOSIA_MODEL", "claude-sonnet-4-20250514")
BUILD_MODEL = os.environ.get("COMPOSIA_BUILDER_MODEL", "claude-haiku-4-5-20251001")
JUDGE_MODEL = os.environ.get("COMPOSIA_JUDGE_MODEL", "claude-haiku-4-5-20251001")
WIKI_PATH = "/tmp/composia-longmemeval-wiki"
MAX_QUESTIONS = int(os.environ.get("LONGMEMEVAL_MAX_Q", "50"))  # 0 = all

client = anthropic.Anthropic()


# --- Official LongMemEval judge prompts (from evaluate_qa.py) ---

JUDGE_PROMPTS = {
    "single-session-user": (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
        "If the response is equivalent to the correct answer or contains all the intermediate "
        "steps to get the correct answer, you should also answer yes. If the response only "
        "contains a subset of the information required by the answer, answer no.\n\n"
        "Question: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\n"
        "Is the model response correct? Answer yes or no only."
    ),
    "single-session-assistant": (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
        "If the response is equivalent to the correct answer or contains all the intermediate "
        "steps to get the correct answer, you should also answer yes. If the response only "
        "contains a subset of the information required by the answer, answer no.\n\n"
        "Question: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\n"
        "Is the model response correct? Answer yes or no only."
    ),
    "single-session-preference": (
        "I will give you a question, a rubric for desired personalized response, and a "
        "response from a model. Please answer yes if the response satisfies the desired "
        "response. Otherwise, answer no. The model does not need to reflect all the points "
        "in the rubric. The response is correct as long as it recalls and utilizes the "
        "user's personal information correctly.\n\n"
        "Question: {question}\n\nRubric: {answer}\n\nModel Response: {response}\n\n"
        "Is the model response correct? Answer yes or no only."
    ),
    "multi-session": (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
        "If the response is equivalent to the correct answer or contains all the intermediate "
        "steps to get the correct answer, you should also answer yes. If the response only "
        "contains a subset of the information required by the answer, answer no.\n\n"
        "Question: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\n"
        "Is the model response correct? Answer yes or no only."
    ),
    "temporal-reasoning": (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
        "If the response is equivalent to the correct answer or contains all the intermediate "
        "steps to get the correct answer, you should also answer yes. If the response only "
        "contains a subset of the information required by the answer, answer no. "
        "In addition, do not penalize off-by-one errors for the number of days. "
        "If the question asks for the number of days/weeks/months, etc., and the model makes "
        "off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's "
        "response is still correct.\n\n"
        "Question: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\n"
        "Is the model response correct? Answer yes or no only."
    ),
    "knowledge-update": (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
        "If the response contains some previous information along with an updated answer, "
        "the response should be considered as correct as long as the updated answer is the "
        "required answer.\n\n"
        "Question: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\n"
        "Is the model response correct? Answer yes or no only."
    ),
    "abstention": (
        "I will give you an unanswerable question, an explanation, and a response from a "
        "model. Please answer yes if the model correctly identifies the question as "
        "unanswerable. The model could say that the information is incomplete, or some "
        "other information is given but the asked information is not.\n\n"
        "Question: {question}\n\nExplanation: {answer}\n\nModel Response: {response}\n\n"
        "Does the model correctly identify the question as unanswerable? Answer yes or no only."
    ),
}


def judge_answer(question, answer, response, task_type):
    """Official LongMemEval LLM-as-judge evaluation."""
    prompt_template = JUDGE_PROMPTS.get(task_type, JUDGE_PROMPTS["single-session-user"])

    try:
        resp = client.messages.create(
            model=JUDGE_MODEL,
            max_tokens=16,
            messages=[{
                "role": "user",
                "content": prompt_template.format(
                    question=question, answer=answer, response=response
                )
            }]
        )
        text = resp.content[0].text.strip().lower()
        return 1.0 if text.startswith("yes") else 0.0
    except Exception as e:
        print(f"    Judge error: {e}")
        return 0.0


# --- Data loading ---

def load_longmemeval():
    """Load LongMemEval dataset."""
    if os.path.exists(LONGMEMEVAL_PATH):
        with open(LONGMEMEVAL_PATH) as f:
            return json.load(f)

    # Try alternate paths
    alt_paths = [
        "/tmp/longmemeval/data/longmemeval_s_cleaned.json",
        "/tmp/longmemeval/data/longmemeval_m_cleaned.json",
    ]
    for p in alt_paths:
        if os.path.exists(p):
            with open(p) as f:
                return json.load(f)

    print(f"Cannot find LongMemEval data at {LONGMEMEVAL_PATH}")
    print("Clone https://github.com/xiaowu0162/LongMemEval and download data.")
    sys.exit(1)


def extract_sessions_from_question(q_data):
    """Extract chat history sessions relevant to a question."""
    sessions = []
    if "haystack_sessions" in q_data:
        for session in q_data["haystack_sessions"]:
            if isinstance(session, list):
                turns = []
                for turn in session:
                    if isinstance(turn, dict):
                        role = turn.get("role", "user")
                        content = turn.get("content", "")
                        turns.append(f"{role}: {content}")
                    elif isinstance(turn, str):
                        turns.append(turn)
                sessions.append("\n".join(turns))
            elif isinstance(session, str):
                sessions.append(session)
    return sessions


# --- Systems under test ---

def run_wiki_system(questions):
    """Wiki-as-context: ingest sessions, then answer from wiki."""
    results = []

    for i, q_data in enumerate(questions):
        # Reset wiki per question (each has its own session history)
        if Path(WIKI_PATH).exists():
            shutil.rmtree(WIKI_PATH)
        wiki = Wiki(WIKI_PATH).init()
        builder = PromptBuilder(wiki, model=BUILD_MODEL)
        updater = WikiUpdater(wiki, model=BUILD_MODEL)

        # Ingest sessions
        sessions = extract_sessions_from_question(q_data)
        for j, session in enumerate(sessions):
            if session.strip():
                updater.update(f"[Session {j+1}]\n{session}", source="conversation")

        wiki.load()

        # Answer
        question = q_data["question"]
        ground_truth = q_data["answer"]
        task_type = q_data.get("type", q_data.get("task", "single-session-user"))

        system_prompt, relevant = builder.build(question)
        resp = client.messages.create(
            model=REASON_MODEL,
            max_tokens=512,
            system=system_prompt,
            messages=[{"role": "user", "content": question}]
        )
        answer = resp.content[0].text

        score = judge_answer(question, ground_truth, answer, task_type)
        results.append({
            "question": question, "ground_truth": ground_truth,
            "answer": answer, "type": task_type,
            "judge": score, "wiki_pages": wiki.page_count(),
        })
        print(f"    Q{i+1} [{task_type}]: judge={score:.0f} | {question[:50]}...")

    return results


def run_full_context_baseline(questions):
    """Baseline: stuff all sessions into prompt."""
    results = []

    for i, q_data in enumerate(questions):
        sessions = extract_sessions_from_question(q_data)
        context = "\n\n---\n\n".join(sessions)

        question = q_data["question"]
        ground_truth = q_data["answer"]
        task_type = q_data.get("type", q_data.get("task", "single-session-user"))

        system = (
            "You are answering questions about conversations you observed. "
            "Use ONLY the conversations provided. If the answer cannot be determined, say so."
        )

        resp = client.messages.create(
            model=REASON_MODEL,
            max_tokens=512,
            system=system,
            messages=[{
                "role": "user",
                "content": f"Conversations:\n\n{context}\n\nQuestion: {question}"
            }]
        )
        answer = resp.content[0].text

        score = judge_answer(question, ground_truth, answer, task_type)
        results.append({
            "question": question, "ground_truth": ground_truth,
            "answer": answer, "type": task_type, "judge": score,
        })
        print(f"    Q{i+1} [{task_type}]: judge={score:.0f} | {question[:50]}...")

    return results


# --- Main ---

def print_results(name, results):
    by_type = {}
    for r in results:
        t = r["type"]
        if t not in by_type:
            by_type[t] = []
        by_type[t].append(r)

    print(f"\n  {name}:")
    total_correct, total_n = 0, 0
    for t in sorted(by_type.keys()):
        rs = by_type[t]
        acc = sum(r["judge"] for r in rs) / len(rs)
        print(f"    {t:30s}: {acc:.1%}  (n={len(rs)})")
        total_correct += sum(r["judge"] for r in rs)
        total_n += len(rs)

    overall = total_correct / total_n if total_n else 0
    print(f"    {'OVERALL':30s}: {overall:.1%}  (n={total_n})")
    return overall


def main():
    print("=" * 70)
    print("LongMemEval BENCHMARK (ICLR 2025)")
    print("500 questions, 5 memory capabilities, official judge prompts")
    print(f"Reasoning model: {REASON_MODEL}")
    print(f"Builder/Judge model: {BUILD_MODEL}")
    print(f"Max questions: {'all' if MAX_QUESTIONS == 0 else MAX_QUESTIONS}")
    print("=" * 70)

    data = load_longmemeval()

    if isinstance(data, dict):
        # Some formats have questions nested
        questions = data.get("questions", data.get("data", list(data.values())))
        if isinstance(questions, dict):
            questions = list(questions.values())
    elif isinstance(data, list):
        questions = data
    else:
        print(f"Unexpected data format: {type(data)}")
        sys.exit(1)

    if MAX_QUESTIONS > 0:
        questions = questions[:MAX_QUESTIONS]

    print(f"Loaded {len(questions)} questions")

    # System A: Wiki
    print(f"\n[A] WIKI-AS-CONTEXT")
    wiki_results = run_wiki_system(questions)

    # System B: Baseline
    print(f"\n[B] FULL CONTEXT BASELINE")
    baseline_results = run_full_context_baseline(questions)

    # Results
    print("\n" + "=" * 70)
    print("FINAL RESULTS")
    print("=" * 70)

    wiki_acc = print_results("Wiki-as-context", wiki_results)
    base_acc = print_results("Full-context baseline", baseline_results)

    print(f"\n  Difference: {wiki_acc - base_acc:+.1%}")
    print(f"  Winner: {'WIKI' if wiki_acc > base_acc else 'BASELINE' if base_acc > wiki_acc else 'TIE'}")

    # Save
    output = {
        "config": {"reason_model": REASON_MODEL, "build_model": BUILD_MODEL},
        "wiki_results": wiki_results,
        "baseline_results": baseline_results,
        "summary": {"wiki_accuracy": wiki_acc, "baseline_accuracy": base_acc},
    }
    out_path = "bench_longmemeval_results.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n  Raw results saved to {out_path}")

    # Reference
    print(f"\n  Reference (from LongMemEval paper):")
    print(f"    GPT-4o full context:  ~45% accuracy")
    print(f"    GPT-4o + RAG:         ~55% accuracy")
    print(f"    Commercial assistants: 30% accuracy drop over sustained interactions")


if __name__ == "__main__":
    main()
