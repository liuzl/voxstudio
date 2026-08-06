/**
 * Gateway wiring of the agent-run controller's speech sink onto the conversation
 * loop's agent-speech channel (docs/voice-agent-roadmap.md §3.3, Phase A).
 *
 * - speak → queueAgentSpeech: the loop narrates at the next idle gap as an
 *   agent-initiated turn, interruptible like any reply;
 * - cancelQueued → clearQueuedAgentSpeech: drops queued narration that has not
 *   started while current playback continues (the stale-progress/barge-in rule);
 * - stop → clearQueuedAgentSpeech plus the injected playback interrupt, so an
 *   explicit cancel, hang-up, or broken executor also stops what is audible now.
 *
 * Speech-kind priority (answers preempt milestones) is applied upstream by the
 * controller's scheduling; the conversation channel keeps one agent-speech queue.
 */
import type { ConversationControls } from "@voxstudio/conversation";
import type { AgentSpeechKind, AgentSpeechSink } from "./agent-run-controller";

export function createAgentSpeechSink(
  controls: ConversationControls,
  interrupt: () => void,
): AgentSpeechSink {
  return {
    speak(kind: AgentSpeechKind, text: string): void {
      void kind;
      controls.queueAgentSpeech(text);
    },
    cancelQueued(): void {
      controls.clearQueuedAgentSpeech();
    },
    stop(): void {
      controls.clearQueuedAgentSpeech();
      interrupt();
    },
  };
}
