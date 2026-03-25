---
title: "Why I Built Synth"
description: "I started using Claude at my day job as a DevOps Engineer. It let me step beyond the build-configure-deploy loop into real software engineering. That curiosity snowballed into something I couldn't stop working on."
pubDate: 2026-03-18
updatedDate: 2026-03-24
author: "Joe Fullerton"
tags: ["deployment", "devops", "architecture", "building-in-public"]
---

I started using Claude at my day job as a DevOps Engineer. I've spent years writing deployment scripts, maintaining runbooks, debugging infrastructure. Claude allowed me to step into more traditional software engineering tasks beyond the build, configure, deploy, automate side of things. Using Claude at work made me curious to see what it could really do.

I started experimenting on my own time. Not with any goal in mind, just pulling on threads. One night I opened a fresh Claude Desktop session and typed: *"What are some project ideas that could leverage an MCP server?"* I'd just heard about MCP and wanted to understand what it could do.

That session went somewhere I didn't expect. I started thinking through whether you could run an MCP server inside a container, and if you could, what that meant. You could pair it with APIs. You could point it at real infrastructure. It could actually interact with systems, not just describe them.

That's where the idea stuck: *could you use a containerized MCP as a deployment tool?*

The answer turned out to be more nuanced than the question. Synth isn't a containerized MCP — it's a deployment system that uses MCP as its agent protocol and can itself be deployed in containers. But that initial question was the spark that got me building.

## The Problem That Clicked

I've been deploying software for a long time. The pattern is always the same:

1. Infrastructure grows
2. Deployment automation gets more complex to match
3. You end up maintaining dozens of scripts and runbooks
4. Each infrastructure change means updating automation
5. That maintenance becomes its own job

Current deployment tools ask: *"How do I execute what you told me to execute?"* They're reactive. You write the scripts, the playbooks, the configs. The tool follows instructions.

This works until infrastructure gets complex. You end up writing automation to manage the automation. You hope the scripts don't hit an edge case and things turn red.

That's not a scripting problem. It's a reasoning problem.

What if you could just say *"deploy this to production"* and the system actually figured it out? Not blindly, but by analyzing the artifact, understanding the target, catching problems, reasoning about the safest approach, and explaining every decision?

## What I Actually Built

I started calling it DeployStack. It's called Synth now.

The core idea: you declare **what** you're deploying and **where**. Synth figures out **how**.

There are two distinct phases, and the separation is the whole point:

**Planning:** The LLM reasons freely, analyzing artifacts, probing infrastructure, detecting conflicts, and producing a deployment plan. This phase is read-only. No side effects. It can think as hard as it needs to.

**Execution:** Once you approve the plan, the system executes it deterministically — the exact plan the LLM created, possibly with your input. No re-reasoning, no improvisation. If something fails mid-execution, it rolls back. It doesn't try to be clever.

Intelligence during planning. Determinism during execution. That's the architecture.

It's source-available, self-hosted, MCP-native from day one, and works with Claude, GPT, Gemini, or Ollama. Every decision gets logged in plain language: what was done, what the reasoning was, and what information drove it.

## Why This Post Exists

Building is the easy part. For someone like me, anyway. Being able to steer and direct a project, shaping the architecture, making the product decisions, without constantly worrying about the code working... it's the most creatively free I've felt in my career. Having a deep technical background means I know when to push back on what the AI suggests. But it doesn't help with the other side of this.

Publishing and presenting what you built — that's the hard part. It's a different skill set entirely, and not one I'm naturally drawn to.

This is me doing it anyway.

## What's Next

Synth has a free Community tier (up to 10 Envoys). If you want more, I'm running a Pioneer Program — free Enterprise access in exchange for real-world feedback.

I want to learn how your teams deploy. What works, what's missing, what I got wrong. If you're managing deployments across environments and tired of maintaining the automation that's supposed to save you time, I'd like to hear from you.

[synthops.app](https://synthops.app)
