
import sys, json, os, math
import cv2
import numpy as np

def get_frames(video_path, max_frames=80):
    """Extract frames evenly from video"""
    cap = cv2.VideoCapture(video_path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    
    if total <= max_frames:
        indices = range(total)
    else:
        indices = np.linspace(0, total-1, max_frames, dtype=int)
    
    frames = []
    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if ret:
            frames.append(frame)
    
    cap.release()
    return frames, fps

def detect_faces_haar(frame):
    """Detect faces using OpenCV's Haar Cascade (built-in)"""
    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = face_cascade.detectMultiScale(gray, 1.1, 4)
    
    crops = []
    h, w = frame.shape[:2]
    
    for (x, y, fw, fh) in faces:
 
        pad = int(fw * 0.2)
        x1 = max(0, x - pad)
        y1 = max(0, y - pad)
        x2 = min(w, x + fw + pad)
        y2 = min(h, y + fh + pad)
        
        crop = frame[y1:y2, x1:x2]
        if crop.size > 0:
            crops.append((crop, (x1, y1, x2, y2)))
    
    return crops


def analyze_color_stability(frames):
    """Check if face colors remain consistent over time"""
    color_features = []
    
    for frame in frames[:40]:
        faces = detect_faces_haar(frame)
        if not faces:
            continue
        
        crop, _ = faces[0]
     
        b_mean, g_mean, r_mean = [np.mean(crop[:,:,i]) for i in range(3)]
        b_std, g_std, r_std = [np.std(crop[:,:,i]) for i in range(3)]
        
        color_features.append([b_mean, g_mean, r_mean, b_std, g_std, r_std])
    
    if len(color_features) < 5:
        return 0.5
    
    features = np.array(color_features)
    
 
    temporal_variance = np.mean([np.std(features[:, i]) for i in range(6)])
    
  
    score = min(1.0, max(0.0, (temporal_variance - 5) / 10))
    return score


def analyze_motion_consistency(frames):
    """Detect unnatural motion patterns"""
    if len(frames) < 6:
        return 0.5
    
    flow_magnitudes = []
    prev_gray = cv2.cvtColor(frames[0], cv2.COLOR_BGR2GRAY)
    
    for i in range(1, min(len(frames), 30)):
        gray = cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY)
        
    
        flow = cv2.calcOpticalFlowFarneback(
            prev_gray, gray, None, 
            pyr_scale=0.5, levels=3, winsize=15, 
            iterations=3, poly_n=5, poly_sigma=1.2, flags=0
        )
        
        magnitude = np.sqrt(flow[..., 0]**2 + flow[..., 1]**2)
        flow_magnitudes.append(np.mean(magnitude))
        prev_gray = gray
    
    if len(flow_magnitudes) < 3:
        return 0.5
    
    flow_std = np.std(flow_magnitudes)
    flow_mean = np.mean(flow_magnitudes)
    
    if flow_mean < 0.01:
        return 0.5
    
 
    variance_ratio = flow_std / flow_mean
    
 
    if variance_ratio < 0.25:
        return 0.75
    elif variance_ratio > 2.5:
        return 0.7
    else:
        return 0.3


def analyze_sharpness_consistency(frames):
    """Deepfakes often have inconsistent sharpness"""
    sharpness_values = []
    
    for frame in frames[:35]:
        faces = detect_faces_haar(frame)
        if not faces:
            continue
        
        crop, _ = faces[0]
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        
 
        laplacian = cv2.Laplacian(gray, cv2.CV_64F)
        sharpness = laplacian.var()
        sharpness_values.append(sharpness)
    
    if len(sharpness_values) < 5:
        return 0.5
    
    mean_sharp = np.mean(sharpness_values)
    std_sharp = np.std(sharpness_values)
    
    blur_score = 0.0
    if mean_sharp < 50:
        blur_score = 0.6
    
    if std_sharp > mean_sharp * 0.5:  
        return max(blur_score, 0.7)
    
    return blur_score if blur_score > 0.4 else 0.3

def analyze_frequency_spectrum(frames):
    """Deepfakes leave artifacts in frequency domain"""
    high_freq_ratios = []
    
    for frame in frames[:25]:
        faces = detect_faces_haar(frame)
        if not faces:
            continue
        
        crop, _ = faces[0]
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        

        f = np.fft.fft2(gray)
        fshift = np.fft.fftshift(f)
        magnitude = np.abs(fshift)
        

        h, w = magnitude.shape
        center_ratio = 0.3
        cy, cx = h // 2, w // 2
        
        center_h = int(h * center_ratio)
        center_w = int(w * center_ratio)
        
        center = magnitude[cy-center_h:cy+center_h, cx-center_w:cx+center_w]
        total = magnitude
        
        center_energy = np.sum(center)
        total_energy = np.sum(total)
        
        if total_energy > 0:
            high_freq_ratio = 1 - (center_energy / total_energy)
            high_freq_ratios.append(high_freq_ratio)
    
    if len(high_freq_ratios) < 3:
        return 0.5
    
    avg_ratio = np.mean(high_freq_ratios)
    

    if avg_ratio < 0.4:
        return 0.7
    elif avg_ratio > 0.6:
        return 0.3
    else:
        return 0.5


def analyze_face_size_stability(frames):
    """Deepfakes may have unstable face boundaries"""
    face_sizes = []
    
    for frame in frames[:50]:
        faces = detect_faces_haar(frame)
        if not faces:
            continue
        
        crop, (x1, y1, x2, y2) = faces[0]
        size = (x2 - x1) * (y2 - y1)
        face_sizes.append(size)
    
    if len(face_sizes) < 5:
        return 0.5
    
    sizes = np.array(face_sizes)
    mean_size = np.mean(sizes)
    std_size = np.std(sizes)
    
    if mean_size == 0:
        return 0.5
 
    cv = std_size / mean_size
    
  
    score = min(1.0, max(0.0, (cv - 0.1) / 0.2))
    return score

def analyze_histogram_consistency(frames):
    """Check color histogram stability"""
    histograms = []
    
    for frame in frames[:30]:
        faces = detect_faces_haar(frame)
        if not faces:
            continue
        
        crop, _ = faces[0]
        

        hist_features = []
        for i in range(3): 
            hist = cv2.calcHist([crop], [i], None, [32], [0, 256])
            hist = hist.flatten() / hist.sum()  
            hist_features.extend(hist.tolist())
        
        histograms.append(hist_features)
    
    if len(histograms) < 5:
        return 0.5
    
    histograms = np.array(histograms)
    

    temporal_var = np.mean(np.std(histograms, axis=0))
    
   
    score = min(1.0, temporal_var / 0.08)
    return score

def aggregate_features(frames, fps):
    """Combine all features with weighted scoring"""
    
    print("Analyzing color stability...", file=sys.stderr)
    color_score = analyze_color_stability(frames)
    
    print("Checking motion consistency...", file=sys.stderr)
    motion_score = analyze_motion_consistency(frames)
    
    print("Evaluating sharpness...", file=sys.stderr)
    sharpness_score = analyze_sharpness_consistency(frames)
    
    print("Analyzing frequency spectrum...", file=sys.stderr)
    freq_score = analyze_frequency_spectrum(frames)
    
    print("Checking face stability...", file=sys.stderr)
    stability_score = analyze_face_size_stability(frames)
    
    print("Analyzing histograms...", file=sys.stderr)
    hist_score = analyze_histogram_consistency(frames)
    

    weights = {
        'color': 0.20,
        'motion': 0.20,
        'sharpness': 0.20,
        'frequency': 0.20,
        'stability': 0.10,
        'histogram': 0.10
    }
    
    combined_score = (
        weights['color'] * color_score +
        weights['motion'] * motion_score +
        weights['sharpness'] * sharpness_score +
        weights['frequency'] * freq_score +
        weights['stability'] * stability_score +
        weights['histogram'] * hist_score
    )
    
    probability = float(combined_score * 100)
    
    details = {
        "color_stability": float(round(color_score, 3)),
        "motion_consistency": float(round(motion_score, 3)),
        "sharpness_quality": float(round(sharpness_score, 3)),
        "frequency_artifacts": float(round(freq_score, 3)),
        "face_stability": float(round(stability_score, 3)),
        "histogram_consistency": float(round(hist_score, 3)),
        "frames_analyzed": int(len(frames)),
        "fps": float(round(fps, 2))
    }
    
    return probability, details

def detect(video_path):
    """Main detection function"""
    if not os.path.exists(video_path):
        return {"error": "File not found"}
    
    print(f"Analyzing: {video_path}", file=sys.stderr)
    
    frames, fps = get_frames(video_path, max_frames=80)
    
    if len(frames) < 5:
        return {"error": "Video too short (need at least 5 frames)"}
    
    probability, details = aggregate_features(frames, fps)
    
    is_deepfake = bool(probability > 50)
    confidence = int(probability if is_deepfake else 100 - probability)
    
    return {
        "type": "video",
        "isDeepfake": is_deepfake,
        "confidence": confidence,
        "details": details,
        "method": "opencv-only-ensemble"
    }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        result = {"error": "No video path provided"}
        print(json.dumps(result), flush=True)
        sys.exit(1)
    
    video_path = sys.argv[1]
    
    try:
        result = detect(video_path)
  
        print(json.dumps(result), flush=True)
        sys.exit(0)
    except Exception as e:
        error_result = {"error": str(e), "traceback": str(e)}
        print(json.dumps(error_result), flush=True)
        sys.exit(1)