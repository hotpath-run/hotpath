// First import on purpose: it must run before the dependencies that trigger the
// punycode deprecation warning are loaded.
import "./silence-warnings.js";

import { applyHomeFlag } from "./home.js";

// Before the program loads: its modules fix the project folder when imported.
applyHomeFlag(process.argv, process.env);

const { createProgram } = await import("./program.js");
createProgram().parse(process.argv);
