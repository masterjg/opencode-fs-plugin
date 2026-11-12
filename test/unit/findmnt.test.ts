/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { describe, expect, it } from "vitest";
import { parseMount } from "../../src/tools/findmnt.js";

describe("mountinfo parsing", () => {
  it("extracts target, source, type and options", () => {
    const mount = parseMount("36 25 0:32 / /mnt/data rw,relatime shared:1 - ext4 /dev/sda1 rw");
    expect(mount).toEqual({
      target: "/mnt/data",
      source: "/dev/sda1",
      fsType: "ext4",
      options: "rw,relatime",
    });
  });

  it("decodes octal escapes in paths", () => {
    const mount = parseMount("36 25 0:32 / /mnt/with\\040space\\011tab rw - tmpfs tmpfs rw");
    expect(mount.target).toBe("/mnt/with space\ttab");
  });
});
