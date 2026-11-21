// Getting a picture to put in the circle (AvatarCropScreen) and the square sent to the Mac: from
// the camera, the album, or a picture in the room (pictureModel.ts roomPictures). Every source is
// first drawn once into a JPEG with its orientation applied, so the size the crop works out matches
// the pixels it cuts.
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";

import { refreshAssetUrl } from "../../state/assets";
import { avatarEdge, type CropRect } from "./pictureModel";

export interface PreparedPicture {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}

/** The longest edge kept for cropping: plenty for a 1024 square, quick to move around. */
const CROP_SOURCE_EDGE = 2048;

/** Draws the picture upright, at most CROP_SOURCE_EDGE on its longer side, into a file. */
export async function preparePicture(uri: string): Promise<PreparedPicture> {
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  let image = await ImageManipulator.manipulate(uri).renderAsync();
  try {
    const longer = Math.max(image.width, image.height);
    if (longer > CROP_SOURCE_EDGE) {
      const scale = CROP_SOURCE_EDGE / longer;
      const resized = await ImageManipulator.manipulate(image)
        .resize({ width: Math.round(image.width * scale), height: Math.round(image.height * scale) })
        .renderAsync();
      image.release();
      image = resized;
    }
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.95 });
    return { uri: saved.uri, width: saved.width, height: saved.height };
  } finally {
    image.release();
  }
}

/** The square inside the circle as a JPEG data URL, at most 1024 pixels a side. */
export async function renderAvatar(picture: PreparedPicture, crop: CropRect): Promise<string> {
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  const edge = avatarEdge(crop);
  const image = await ImageManipulator.manipulate(picture.uri).crop(crop).resize({ width: edge, height: edge }).renderAsync();
  try {
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.88, base64: true });
    if (!saved.base64) throw new Error("The cropped picture has no bytes.");
    return `data:image/jpeg;base64,${saved.base64}`;
  } finally {
    image.release();
  }
}

export type PickResult = { readonly picture: PreparedPicture } | { readonly denied: true } | null;

/** A photo taken now; null when the person cancels, denied when the camera is not allowed. */
export async function takePhoto(): Promise<PickResult> {
  const picker = await import("expo-image-picker");
  const permission = await picker.requestCameraPermissionsAsync();
  if (!permission.granted) return { denied: true };
  const result = await picker.launchCameraAsync({ mediaTypes: ["images"], quality: 1, allowsEditing: false });
  const asset = result.canceled ? null : result.assets[0];
  return asset ? { picture: await preparePicture(asset.uri) } : null;
}

/** One picture from the album (the system picker needs no permission); null when cancelled. */
export async function chooseFromAlbum(): Promise<PickResult> {
  const picker = await import("expo-image-picker");
  const result = await picker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: false,
    quality: 1,
    shouldDownloadFromNetwork: true,
  });
  const asset = result.canceled ? null : result.assets[0];
  return asset ? { picture: await preparePicture(asset.uri) } : null;
}

/** A picture in the room, fetched from the Mac into the phone's cache. */
export async function fetchRoomPicture(environmentId: EnvironmentId, resource: AssetResource): Promise<PreparedPicture> {
  const url = await refreshAssetUrl(environmentId, resource);
  if (!url) throw new Error("This Mac is not connected.");
  const { File, Paths } = await import("expo-file-system");
  const file = new File(Paths.cache, `rubato-avatar-${Date.now()}`);
  const downloaded = await File.downloadFileAsync(url, file);
  try {
    return await preparePicture(downloaded.uri);
  } finally {
    try {
      if (downloaded.exists) downloaded.delete();
    } catch {
      // The cache is cleared by the system in time.
    }
  }
}
