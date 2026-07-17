import { expect, test } from "bun:test";
import type { ServerMsg } from "../protocol.js";
import { AutomationService } from "./automation.js";
import { RunBus } from "./bus.js";
import { openDb } from "./db.js";
import { RunCoordinator, type DeviceTransport } from "./scheduler.js";
import { HarborStore } from "./store.js";

test("manual automation run persists the manual prompt event even when schedule is disabled", () => {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const agent = store.createAgent(
    { name: "builder", deviceId: device.id, backend: "claude", workdir: "/repo" },
    2,
  );
  const transport: DeviceTransport = {
    isOnline: () => false,
    send: (_deviceId: string, _message: ServerMsg) => false,
  };
  const coordinator = new RunCoordinator(store, new RunBus(), transport, 1);
  const service = new AutomationService(store, coordinator);
  const automation = store.createAutomation(
    {
      name: "daily-report",
      agentId: agent.id,
      cron: "0 9 * * *",
      prompt: "Generate the report",
      mode: "new_issue",
      targetConversationId: null,
      notifyChatId: null,
    },
    3,
  );
  store.setAutomationEnabled(automation.id, false);

  const run = service.runNow(automation.id);

  expect(run.promptEvent).toBe("event.automation.manual");
  expect(run.triggerRef).toBe(automation.id);
  expect(store.getConversation(run.conversationId)).toEqual(
    expect.objectContaining({ origin: "automation", originRef: automation.id }),
  );
  expect(store.listAutomationLog(automation.id).at(-1)).toEqual(
    expect.objectContaining({ kind: "fired", runId: run.id, note: "manual" }),
  );
});
