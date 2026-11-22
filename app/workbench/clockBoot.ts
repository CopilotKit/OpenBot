/*
 * The first module of the app frame. It runs before every app module, so every timer and Date read
 * of the app goes through the page clock. Math.random gets a fixed seed, so each load draws the same.
 */
import {
  installClock,
  type PageClock,
  SCENE_EPOCH,
} from "../../desktop/workbench/clock";
import { mulberry32 } from "./random";

declare global {
  var __workbenchClock: PageClock | undefined;
}

const clock = installClock(SCENE_EPOCH);
globalThis.__workbenchClock = clock;
Math.random = mulberry32(1);
