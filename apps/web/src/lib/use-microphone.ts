import { useEffect, useState } from "react";
import { grantMicrophonePermission, listAudioInputDevices, type AudioInputDevice } from "./audio";

export interface MicrophoneDevices {
  devices: AudioInputDevice[];
  /** True while the browser hides device labels until microphone permission is granted. */
  needsPermission: boolean;
  /** True while an explicit authorize request is in flight. */
  authorizing: boolean;
  /** Request microphone permission from a user gesture, then refresh the list. */
  authorize(): Promise<void>;
  /** Re-enumerate microphones without prompting. */
  refresh(): Promise<void>;
}

export function microphoneDevicesNeedPermission(devices: readonly AudioInputDevice[]): boolean {
  return devices.length === 0 || devices.every(device => device.label === "");
}

/**
 * One device list shared by the conversation and agent-builder pickers. The list is
 * refreshed on `devicechange`, when a stored grant already exists, and after an
 * explicit authorize; pre-permission placeholders never appear as fake devices.
 */
export function useMicrophoneDevices(): MicrophoneDevices {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [authorizing, setAuthorizing] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      setDevices(await listAudioInputDevices());
    } catch {
      setDevices([]);
    }
  };

  useEffect(() => {
    let alive = true;
    let permissionStatus: PermissionStatus | undefined;
    const handlePermissionChange = (): void => {
      if (permissionStatus?.state === "granted") {
        void grantMicrophonePermission().then(refreshIfAlive).catch(() => {});
      }
    };
    const refreshIfAlive = (): void => {
      void listAudioInputDevices().then(next => {
        if (alive) setDevices(next);
      }).catch(() => {
        if (alive) setDevices([]);
      });
    };
    refreshIfAlive();
    // A returning user with a stored grant should see real names immediately. The
    // permission query never prompts, so this is silent; other states wait for the
    // explicit authorize button or the start gesture's own getUserMedia grant.
    const permissions = navigator.permissions;
    if (permissions?.query !== undefined) {
      void permissions.query({ name: "microphone" as PermissionName })
        .then(status => {
          if (!alive) return;
          permissionStatus = status;
          if (status.state === "granted") {
            void grantMicrophonePermission().then(refreshIfAlive).catch(() => {});
          }
          status.addEventListener?.("change", handlePermissionChange);
        })
        .catch(() => {});
    }
    navigator.mediaDevices.addEventListener?.("devicechange", refreshIfAlive);
    return () => {
      alive = false;
      permissionStatus?.removeEventListener?.("change", handlePermissionChange);
      navigator.mediaDevices.removeEventListener?.("devicechange", refreshIfAlive);
    };
  }, []);

  const authorize = async (): Promise<void> => {
    setAuthorizing(true);
    try {
      await grantMicrophonePermission();
      await refresh();
    } finally {
      setAuthorizing(false);
    }
  };

  // Before the first grant every reported label is empty, so the picker shows the
  // authorize affordance instead of a meaningless numbered fallback.
  const needsPermission = microphoneDevicesNeedPermission(devices);
  return { devices, needsPermission, authorizing, authorize, refresh };
}
