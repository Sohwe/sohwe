import type Docker from "dockerode";
import { ImageReferenceSchema } from "@sohwe/types";

/** Pull a public image and return its immutable local image ID for this deploy. */
export async function pullPublicImage(docker: Docker, reference: string): Promise<string> {
  const imageRef = ImageReferenceSchema.parse(reference);
  const stream = await docker.pull(imageRef);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (error) => error ? reject(error) : resolve());
  });
  const image = await docker.getImage(imageRef).inspect();
  if (!image.Id) throw new Error("The pulled image has no Docker image ID.");
  return image.Id;
}
