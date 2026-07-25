import type {
  Device,
  DeviceCapabilities,
  DeviceSummary,
} from "./protocol.js";

/** 完整 runtime snapshot 的稳定读模型；正文只保留在 DeviceCapabilities。 */
export function summarizeDeviceCapabilities(
  capabilities: DeviceCapabilities,
): DeviceSummary["capabilities"] {
  const { installedSkills, ...summary } = capabilities;
  return {
    ...summary,
    installedSkills: installedSkills?.map(
      ({ instruction: _instruction, files, ...skill }) => ({
        ...skill,
        fileCount: files?.length ?? 1,
      }),
    ),
  };
}

export function summarizeDevice(device: Device): DeviceSummary {
  return {
    ...device,
    capabilities: summarizeDeviceCapabilities(device.capabilities),
  };
}
