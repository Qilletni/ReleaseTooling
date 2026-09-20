import { describe, it, expect } from "vitest";
import * as japicmpPolicy from "../src/japicmp_policy.js";

const NO_CHANGES = `
<japicmp>
  <classes>
    <class fullyQualifiedName="dev.qilletni.api.Foo" changeStatus="UNCHANGED"
           binaryCompatible="true" sourceCompatible="true">
      <methods>
        <method name="bar" changeStatus="UNCHANGED" binaryCompatible="true" sourceCompatible="true"/>
      </methods>
    </class>
  </classes>
</japicmp>
`;

const ADDITIVE_ONLY = `
<japicmp>
  <classes>
    <class fullyQualifiedName="dev.qilletni.api.Foo" changeStatus="MODIFIED"
           binaryCompatible="true" sourceCompatible="true">
      <methods>
        <method name="newMethod" changeStatus="NEW" binaryCompatible="true" sourceCompatible="true"/>
      </methods>
    </class>
  </classes>
</japicmp>
`;

const BREAKING_CHANGE = `
<japicmp>
  <classes>
    <class fullyQualifiedName="dev.qilletni.api.Foo" changeStatus="MODIFIED"
           binaryCompatible="true" sourceCompatible="true">
      <methods>
        <method name="removedMethod" changeStatus="REMOVED" binaryCompatible="false" sourceCompatible="false"/>
      </methods>
    </class>
  </classes>
</japicmp>
`;

// japicmp emits a <constructor> element per compared constructor. fast-xml-parser
// rejects that tag name outright unless it is renamed before parsing, so a report
// shaped like this one used to abort the entire policy check.
const UNCHANGED_CONSTRUCTOR = `
<japicmp>
  <classes>
    <class fullyQualifiedName="dev.qilletni.api.Foo" changeStatus="UNCHANGED"
           binaryCompatible="true" sourceCompatible="true">
      <constructors>
        <constructor name="Foo" changeStatus="UNCHANGED" binaryCompatible="true" sourceCompatible="true"/>
      </constructors>
    </class>
  </classes>
</japicmp>
`;

const REMOVED_CONSTRUCTOR = `
<japicmp>
  <classes>
    <class fullyQualifiedName="dev.qilletni.api.Foo" changeStatus="MODIFIED"
           binaryCompatible="true" sourceCompatible="true">
      <constructors>
        <constructor name="Foo" changeStatus="REMOVED" binaryCompatible="false" sourceCompatible="false"/>
      </constructors>
    </class>
  </classes>
</japicmp>
`;

const NEW_CONSTRUCTOR = `
<japicmp>
  <classes>
    <class fullyQualifiedName="dev.qilletni.api.Foo" changeStatus="MODIFIED"
           binaryCompatible="true" sourceCompatible="true">
      <constructors>
        <constructor name="Foo" changeStatus="NEW" binaryCompatible="true" sourceCompatible="true"/>
      </constructors>
    </class>
  </classes>
</japicmp>
`;

describe("parseReport", () => {
  it("parses a report containing <constructor> elements", () => {
    const findings = japicmpPolicy.parseReport(UNCHANGED_CONSTRUCTOR);
    expect(findings.additive).toEqual([]);
    expect(findings.breaking).toEqual([]);
  });

  it("detects a removed constructor as breaking and names it as a constructor", () => {
    const findings = japicmpPolicy.parseReport(REMOVED_CONSTRUCTOR);
    expect(findings.additive).toEqual([]);
    expect(findings.breaking).toEqual(["constructor 'Foo'"]);
  });

  it("detects a new constructor as additive", () => {
    const findings = japicmpPolicy.parseReport(NEW_CONSTRUCTOR);
    expect(findings.additive).toEqual(["constructor 'Foo'"]);
    expect(findings.breaking).toEqual([]);
  });

  it("finds no findings when there are no changes", () => {
    const findings = japicmpPolicy.parseReport(NO_CHANGES);
    expect(findings.additive).toEqual([]);
    expect(findings.breaking).toEqual([]);
  });

  it("detects additive-only changes", () => {
    const findings = japicmpPolicy.parseReport(ADDITIVE_ONLY);
    expect(findings.additive.length).toBe(1);
    expect(findings.breaking).toEqual([]);
  });

  it("detects breaking changes", () => {
    const findings = japicmpPolicy.parseReport(BREAKING_CHANGE);
    expect(findings.additive).toEqual([]);
    expect(findings.breaking.length).toBe(1);
  });
});

describe("evaluate", () => {
  it("patch policy allows no changes", () => {
    const [ok, violations] = japicmpPolicy.evaluate(NO_CHANGES, { policy: "patch" });
    expect(ok).toBe(true);
    expect(violations).toEqual([]);
  });

  it("patch policy rejects additive changes", () => {
    const [ok, violations] = japicmpPolicy.evaluate(ADDITIVE_ONLY, { policy: "patch" });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.toLowerCase().includes("additive"))).toBe(true);
  });

  it("patch policy rejects breaking changes", () => {
    const [ok, violations] = japicmpPolicy.evaluate(BREAKING_CHANGE, { policy: "patch" });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.toLowerCase().includes("breaking"))).toBe(true);
  });

  it("minor policy allows additive changes", () => {
    const [ok, violations] = japicmpPolicy.evaluate(ADDITIVE_ONLY, { policy: "minor" });
    expect(ok).toBe(true);
    expect(violations).toEqual([]);
  });

  it("minor policy rejects breaking changes", () => {
    const [ok, violations] = japicmpPolicy.evaluate(BREAKING_CHANGE, { policy: "minor" });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.toLowerCase().includes("breaking"))).toBe(true);
  });

  it("major policy rejects breaking changes without a migration doc", () => {
    const [ok, violations] = japicmpPolicy.evaluate(BREAKING_CHANGE, { policy: "major", hasMigrationDoc: false });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.toLowerCase().includes("migration"))).toBe(true);
  });

  it("major policy allows breaking changes with a migration doc", () => {
    const [ok, violations] = japicmpPolicy.evaluate(BREAKING_CHANGE, { policy: "major", hasMigrationDoc: true });
    expect(ok).toBe(true);
    expect(violations).toEqual([]);
  });

  it("major policy still allows additive changes", () => {
    const [ok] = japicmpPolicy.evaluate(ADDITIVE_ONLY, { policy: "major", hasMigrationDoc: false });
    expect(ok).toBe(true);
  });

  it("throws for an unknown policy", () => {
    expect(() => japicmpPolicy.evaluate(NO_CHANGES, { policy: "banana" })).toThrow();
  });
});
