#!/usr/bin/env node
import { Buffer } from "node:buffer";
import {
	loadSkillEntries,
	skillsSection,
} from "../rubato-pi/src/skills-section.mjs";

const entries = loadSkillEntries();
const bytes = Buffer.byteLength(skillsSection());

console.log(`${entries.length} skills, ${bytes} prompt bytes`);
