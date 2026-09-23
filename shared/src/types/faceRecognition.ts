/**
 * Face detection result carrying only what the head-turn liveness verifier
 * needs: confidence, 68-point landmarks, and the bounding box. Produced by the
 * lighter `detectFaceLandmarksFromBuffer` path, which skips the 128-d descriptor
 * and age/gender inference (community #51).
 */
export interface FaceLandmarksDetectionResult {
  confidence: number;
  landmarks: Array<{ x: number; y: number }>;
  boundingBox: { x: number; y: number; width: number; height: number };
}

/** Full detection result — adds the face embedding (and optional age/gender). */
export interface FaceBufferDetectionResult extends FaceLandmarksDetectionResult {
  embedding: Float32Array;
  age?: number;
  gender?: string;
}
