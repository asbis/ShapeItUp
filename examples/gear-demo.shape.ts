import { gears } from "shapeitup";

export default function main() {
  return gears.spurInvolute({ module: 2, teeth: 18, faceWidth: 8, bore: 6 });
}
