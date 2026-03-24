---
title: "The Rest of the Job"
description: "Deployments are only a fraction of what ops engineers actually do. The same planning intelligence that makes Synth's deployments valuable applies to all of it — the fixes, the investigations, the maintenance, all the work that doesn't start with an artifact."
pubDate: 2026-03-23
author: "Joe Fullerton"
tags: ["deployment", "devops", "operations", "building-in-public"]
draft: false
---

Deployment is the visible part of the job. Most of the job is harder to point to.

It's scheduled, it's logged, it's the thing your team may be known for. But the people who deploy software spend most of their time on everything else: fixing the pipeline, tracking down the bug that slipped through, handling the escalation, troubleshooting the test environment that's been broken since Tuesday. The actual deployment is often the least time-consuming part of the job.

## The Runbook Problem

The industry's answer to operational work is the runbook — a document, or ideally a pre-scripted step sequence, that walks an engineer through a procedure. Some tools let you author these visually. Some version-control them. Some have a decent UI for running them.

They all share a fundamental design where the human writes the steps. The tool executes what it's told.

This works until it doesn't. Runbooks drift, infrastructure changes, but the runbook doesn't. You add a new service and now three runbooks need updating. Someone runs an outdated one and makes things worse. Maintaining the runbooks becomes a huge burden.

The failure is the same one, just slower to surface. You've offloaded execution but not reasoning. Knowing what to do is still entirely your problem.

## What Synth Already Knows How to Do

In Synth's planning phase, the LLM analyzes an artifact, probes a target, detects conflicts, and produces a deployment plan. None of that is specific to deployments. It's reasoning about a system against observed state, toward a goal.

That's the same thing you need for any operational task.

"Rotate the API credentials for the payment service" is an objective. Synth probes the target, finds where credentials are referenced, works out the sequence that avoids downtime, and produces a plan. The same way it handles a deployment.

"The web tier is showing elevated 5xx errors" is an objective. Synth checks what it can: container health, resource usage, recent deployments, log patterns. It reasons about likely causes and proposes specific next steps. Not blindly. With a plain-language explanation of what it looked at and what it found.

The intelligence was always the point. Limiting it to artifacts was an arbitrary constraint.

## Planning Against Observed State

What makes this different from runbooks is that the reasoning happens at runtime, against the actual state of the environment, not against a set of instructions an engineer wrote six months ago.

A runbook knows what you told it to do when you wrote it. Synth's operational planning observes first, then decides.

That distinction matters most when things have already gone wrong. When you're responding to an incident, you don't want a system following a stale script. You want a system that looks at what's actually happening, reasons about it, and tells you specifically what to do and why. Something actionable. Something you can trust because you can see the reasoning behind it.

The plan-then-execute separation holds here too: the system reasons freely during planning, produces a specific plan, and you approve it before a single change is made. You're not handing over control. You're delegating the thinking so you can focus on the decision.

## What This Means for Synth

Synth now extends the same planning model to operational work that doesn't start with an artifact. You describe what you need done. Synth observes the target, plans against what it finds, and explains the plan before touching anything.

This isn't a new product or a new pricing tier. It's the same intelligence, applied to the rest of the job.

If you're building deployment automation and spending most of your time maintaining everything around it, [the conversation is at synthdeploy.com](https://synthdeploy.com).
