#!/usr/bin/env python3
"""
BABILong benchmark using the context engine v2.
Deterministic exact-match evaluation — no F1, no LLM judge.

Usage:
  python3 bench_babilong_v2.py --tasks qa1,qa6 --lengths 0k,4k --samples 5
  python3 bench_babilong_v2.py --tasks qa1,qa2,qa3,qa5,qa6 --lengths 0k,4k,16k --samples 10
"""

import os
import sys
import json
import time
import argparse

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

from datasets import load_dataset
from context_engine.bench_adapter import ContextEngineBenchAdapter


# --- Official BABILong label sets ---

TASK_LABELS = {
    "qa1": ["bathroom", "bedroom", "garden", "hallway", "kitchen", "office"],
    "qa2": ["bathroom", "bedroom", "garden", "hallway", "kitchen", "office"],
    "qa3": ["bathroom", "bedroom", "garden", "hallway", "kitchen", "office"],
    "qa4": ["bathroom", "bedroom", "garden", "hallway", "kitchen", "office"],
    "qa5": ["Bill", "Fred", "Jeff", "Mary", "apple", "football", "milk"],
    "qa6": ["no", "yes"],
    "qa7": ["none", "one", "three", "two"],
    "qa8": ["apple", "football", "milk", "nothing"],
    "qa9": ["no", "yes"],
    "qa10": ["maybe", "no", "yes"],
}


def compare_answers(target, output, question, labels):
    """Official BABILong label matching."""
    output = output.lower().strip()
    for sep in ['.', '\n']:
        if sep in output:
            output = output[:output.index(sep)]

    target = target.lower().strip()
    question = question.lower().strip()

    labels_lower = [l.lower() for l in labels]
    question_labels = {l for l in labels_lower if l in question}
    found_labels = {l for l in labels_lower if l in output and l not in question_labels}

    target_parts = [t.strip() for t in target.split(",")]
    if len(target_parts) == 1:
        return found_labels == {target}
    else:
        return found_labels == set(target_parts)


def run_context_engine(task, length, samples):
    """Run context engine v2 on BABILong samples."""
    results = []
    db_path = f"/var/tmp/composia-babilong/{task}_{length}.db"

    for i, sample in enumerate(samples):
        adapter = ContextEngineBenchAdapter(db_path=db_path)
        adapter.reset()

        # Ingest context in chunks
        text = sample["input"]
        chunk_size = 4000
        chunks = [text[j:j+chunk_size] for j in range(0, len(text), chunk_size)]
        total_nodes = 0
        for chunk in chunks:
            if chunk.strip():
                total_nodes += adapter.ingest_text(chunk)

        # Answer question
        question = sample["question"]
        target = sample["target"]
        answer = adapter.answer_question(question)

        labels = TASK_LABELS.get(task, [])
        correct = compare_answers(target, answer, question, labels)

        stats = adapter.stats()
        results.append({
            "question": question, "target": target, "answer": answer,
            "correct": correct, "nodes": stats.get("session_nodes", 0),
        })

        status = "OK" if correct else "WRONG"
        print(f"    {i+1}/{len(samples)} [{status}] target={target} got={answer[:30]} ({stats.get('session_nodes',0)} nodes)")
        adapter.close()

    return results


def run_baseline(task, length, samples):
    """Full context stuffing baseline."""
    import anthropic
    client = anthropic.Anthropic()
    model = os.environ.get("COMPOSIA_MODEL", "claude-sonnet-4-20250514")
    results = []

    for i, sample in enumerate(samples):
        context = sample["input"]
        question = sample["question"]
        target = sample["target"]

        # Truncate if needed
        if len(context) > 600000:
            context = context[:600000] + "\n[TRUNCATED]"

        resp = client.messages.create(
            model=model,
            max_tokens=20,
            temperature=0,
            system="Answer with ONLY a single word.",
            messages=[{"role": "user", "content": f"{context}\n\nQuestion: {question}\nAnswer:"}]
        )
        answer = resp.content[0].text.strip()

        labels = TASK_LABELS.get(task, [])
        correct = compare_answers(target, answer, question, labels)
        results.append({
            "question": question, "target": target, "answer": answer, "correct": correct,
        })

        status = "OK" if correct else "WRONG"
        print(f"    {i+1}/{len(samples)} [{status}] target={target} got={answer[:30]}")

    return results


def main():
    parser = argparse.ArgumentParser(description="BABILong benchmark v2")
    parser.add_argument("--tasks", default="qa1,qa6", help="Comma-separated tasks")
    parser.add_argument("--lengths", default="0k,4k", help="Comma-separated context lengths")
    parser.add_argument("--samples", type=int, default=5, help="Samples per task/length")
    parser.add_argument("--no-baseline", action="store_true", help="Skip baseline")
    args = parser.parse_args()

    tasks = args.tasks.split(",")
    lengths = args.lengths.split(",")

    print("=" * 70)
    print("BABILong BENCHMARK — Context Engine v2")
    print(f"Tasks: {', '.join(tasks)}")
    print(f"Lengths: {', '.join(lengths)}")
    print(f"Samples: {args.samples}")
    print("=" * 70)

    all_results = {}

    for length in lengths:
        print(f"\n{'='*70}")
        print(f"Context length: {length}")

        try:
            ds = load_dataset("RMT-team/babilong", length)
        except Exception as e:
            print(f"  Failed to load {length}: {e}")
            continue

        for task in tasks:
            if task not in ds:
                print(f"  {task} not available at {length}")
                continue

            task_data = list(ds[task])[:args.samples]
            print(f"\n  {task} ({len(task_data)} samples, ~{len(task_data[0]['input'])} chars)")

            # Context engine v2
            print(f"  [A] CONTEXT ENGINE v2")
            start = time.time()
            v2_results = run_context_engine(task, length, task_data)
            v2_time = time.time() - start
            v2_acc = sum(r["correct"] for r in v2_results) / len(v2_results)

            # Baseline
            if not args.no_baseline:
                print(f"  [B] FULL CONTEXT BASELINE")
                start = time.time()
                base_results = run_baseline(task, length, task_data)
                base_time = time.time() - start
                base_acc = sum(r["correct"] for r in base_results) / len(base_results)
            else:
                base_results = []
                base_acc = 0
                base_time = 0

            key = f"{task}_{length}"
            all_results[key] = {
                "v2_accuracy": v2_acc, "v2_time": v2_time,
                "baseline_accuracy": base_acc, "baseline_time": base_time,
            }

            winner = "V2" if v2_acc > base_acc else "BASELINE" if base_acc > v2_acc else "TIE"
            print(f"  >> V2: {v2_acc:.0%} ({v2_time:.0f}s) | Baseline: {base_acc:.0%} ({base_time:.0f}s) | {winner}")

    # Summary
    print(f"\n{'='*70}")
    print("FINAL RESULTS")
    print(f"{'='*70}")
    print(f"\n  {'Task':10s} {'Length':8s} {'V2':8s} {'Base':8s} {'Winner':10s}")
    print(f"  {'-'*46}")

    total_v2, total_base, total_n = 0, 0, 0
    for key in sorted(all_results.keys()):
        r = all_results[key]
        task, length = key.rsplit("_", 1)
        print(f"  {task:10s} {length:8s} {r['v2_accuracy']:7.0%} {r['baseline_accuracy']:7.0%}  "
              f"{'V2' if r['v2_accuracy'] > r['baseline_accuracy'] else 'BASE' if r['baseline_accuracy'] > r['v2_accuracy'] else 'TIE'}")
        total_v2 += r["v2_accuracy"]
        total_base += r["baseline_accuracy"]
        total_n += 1

    if total_n:
        print(f"\n  {'OVERALL':10s} {'':8s} {total_v2/total_n:7.0%} {total_base/total_n:7.0%}")

    # Save
    out_path = "/var/tmp/composia-babilong/results.json"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(all_results, f, indent=2)
    print(f"\n  Results saved to {out_path}")


if __name__ == "__main__":
    main()
