import { listInputDevices, type AudioInputDevice } from "@voxstudio/platform-bun";
import type { CliIo } from "../io";

export const devicesUsage = `usage: vox devices

List microphone input devices. Use the reported ID with \`vox listen --device ID\`.`;

export interface DevicesPlatform {
  listInputDevices(): Promise<AudioInputDevice[]>;
}

const defaultPlatform: DevicesPlatform = { listInputDevices };

export async function runDevices(
  args: string[],
  io: CliIo,
  platform: DevicesPlatform = defaultPlatform,
): Promise<number> {
  if (args.length) throw new TypeError("devices: no arguments expected");
  const devices = await platform.listInputDevices();
  if (devices.length === 0) {
    io.err("devices: no microphone input devices found");
    return 1;
  }
  for (const device of devices) io.out(`${device.id}\t${device.name}`);
  return 0;
}
