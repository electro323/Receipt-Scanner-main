import json
import os
import sys

import cv2
import numpy as np


def order_points(points):
    rect = np.zeros((4, 2), dtype="float32")
    point_sum = points.sum(axis=1)
    point_diff = np.diff(points, axis=1)
    rect[0] = points[np.argmin(point_sum)]
    rect[2] = points[np.argmax(point_sum)]
    rect[1] = points[np.argmin(point_diff)]
    rect[3] = points[np.argmax(point_diff)]
    return rect


def correct_perspective(image):
    ratio = image.shape[0] / 700.0
    small = cv2.resize(image, (int(image.shape[1] / ratio), 700))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 60, 180)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:8]

    for contour in contours:
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.025 * perimeter, True)

        if len(approx) != 4:
            continue

        area = cv2.contourArea(approx)
        image_area = small.shape[0] * small.shape[1]

        if area < image_area * 0.18:
            continue

        rect = order_points(approx.reshape(4, 2).astype("float32") * ratio)
        top_left, top_right, bottom_right, bottom_left = rect
        width_a = np.linalg.norm(bottom_right - bottom_left)
        width_b = np.linalg.norm(top_right - top_left)
        height_a = np.linalg.norm(top_right - bottom_right)
        height_b = np.linalg.norm(top_left - bottom_left)
        max_width = int(max(width_a, width_b))
        max_height = int(max(height_a, height_b))

        if max_width < 250 or max_height < 350:
            continue

        destination = np.array(
            [
                [0, 0],
                [max_width - 1, 0],
                [max_width - 1, max_height - 1],
                [0, max_height - 1],
            ],
            dtype="float32",
        )
        matrix = cv2.getPerspectiveTransform(rect, destination)
        return cv2.warpPerspective(image, matrix, (max_width, max_height))

    return image


def resize_for_ocr(image, target_width=2200):
    height, width = image.shape[:2]
    if width <= 0:
        return image
    scale = target_width / float(width)
    return cv2.resize(image, (target_width, max(1, int(height * scale))), interpolation=cv2.INTER_CUBIC)


def save(path, image):
    cv2.imwrite(path, image)
    return path


def segment_long_receipt(image, base_path):
    height, width = image.shape[:2]
    if height / max(width, 1) < 2.1:
        return []

    segment_height = min(1500, max(900, int(width * 1.25)))
    overlap = 120
    paths = []
    index = 0
    y = 0

    while y < height:
        bottom = min(height, y + segment_height)
        if bottom - y < 380:
            break
        segment = image[y:bottom, :]
        segment_path = f"{base_path}-segment-{index:02d}.png"
        save(segment_path, segment)
        paths.append(segment_path)
        if bottom == height:
            break
        y = max(0, bottom - overlap)
        index += 1

    return paths


def preprocess(input_path):
    image = cv2.imread(input_path)
    if image is None:
        raise ValueError("Could not read image")

    image = correct_perspective(image)
    image = resize_for_ocr(image)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    clahe = cv2.createCLAHE(clipLimit=2.6, tileGridSize=(8, 8)).apply(gray)
    denoised = cv2.medianBlur(clahe, 3)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (23, 23))
    top_hat = cv2.morphologyEx(denoised, cv2.MORPH_TOPHAT, kernel)
    black_hat = cv2.morphologyEx(denoised, cv2.MORPH_BLACKHAT, kernel)
    enhanced = cv2.addWeighted(denoised, 1.0, top_hat, 0.65, 0)
    enhanced = cv2.subtract(enhanced, cv2.multiply(black_hat, 0.35))

    adaptive = cv2.adaptiveThreshold(
        enhanced,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        51,
        13,
    )
    adaptive = cv2.medianBlur(adaptive, 3)

    strong_adaptive = cv2.adaptiveThreshold(
        cv2.medianBlur(clahe, 3),
        255,
        cv2.ADAPTIVE_THRESH_MEAN_C,
        cv2.THRESH_BINARY,
        61,
        15,
    )

    base_path = os.path.splitext(input_path)[0] + "-cv"
    paths = [
        save(base_path + "-clahe.png", clahe),
        save(base_path + "-tophat-adaptive.png", adaptive),
        save(base_path + "-strong-adaptive.png", strong_adaptive),
    ]
    paths.extend(segment_long_receipt(adaptive, base_path))
    return paths


if __name__ == "__main__":
    try:
        print(json.dumps(preprocess(sys.argv[1])))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
