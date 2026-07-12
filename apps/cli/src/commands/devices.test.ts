import { expect, test } from "bun:test";
import { runDevices } from "./devices";

test("lists platform microphone devices without loading engine configuration", async () => {
  const output: string[] = [];
  await expect(runDevices([], { out: line => output.push(line), err: () => {} }, {
    listInputDevices: async () => [{ id: "1", name: "Microphone" }],
  })).resolves.toBe(0);
  expect(output).toEqual(["1\tMicrophone"]);
});

test("reports an empty device list and rejects extra arguments", async () => {
  const errors: string[] = [];
  await expect(runDevices([], { out: () => {}, err: line => errors.push(line) }, {
    listInputDevices: async () => [],
  })).resolves.toBe(1);
  expect(errors).toEqual(["devices: no microphone input devices found"]);
  await expect(runDevices(["unexpected"], { out: () => {}, err: () => {} }, {
    listInputDevices: async () => [],
  })).rejects.toThrow("no arguments");
});
