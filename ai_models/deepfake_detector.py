# deepfake_detector_improved.py
import sys, json, os, math, statistics
import cv2, numpy as np
import face_recognition
import mediapipe as mp

mp_face = mp.solutions.face_mesh

def get_frames(video_path, max_frames=120, resize=(320,320)):
    cap = cv2.VideoCapture(video_path)
    frames=[]
    i=0
    while i < max_frames:
        ret, frame = cap.read()
        if not ret:
            break
        if resize:
            frame = cv2.resize(frame, resize)
        frames.append(frame)
        i+=1
    cap.release()
    return frames

def face_crops_from_frame(frame):
    # use face_recognition to get boxes (top, right, bottom, left)
    rgb = frame[:,:,::-1]
    boxes = face_recognition.face_locations(rgb, model='hog')  # faster; use 'cnn' if GPU and dlib installed
    crops=[]
    for (top, right, bottom, left) in boxes:
        crop = frame[top:bottom, left:right]
        if crop.size == 0: continue
        crops.append(((top,right,bottom,left), crop))
    return crops

def compute_face_embedding(crop):
    rgb = crop[:,:,::-1]
    enc = face_recognition.face_encodings(rgb)
    if enc:
        return enc[0]
    return None

def blink_rate(frames):
    # use mediapipe landmarks to estimate eye aspect ratio changes
    with mp_face.FaceMesh(static_image_mode=False, max_num_faces=1) as fm:
        blink_counts=0
        ratios=[]
        for f in frames:
            img = cv2.cvtColor(f, cv2.COLOR_BGR2RGB)
            res = fm.process(img)
            if not res.multi_face_landmarks: continue
            lm = res.multi_face_landmarks[0].landmark
            h,w = f.shape[:2]
            # eyelid landmarks indices (approx) - left eye sample
            # choose a few landmarks for top/bottom
            # compute simple vertical distance normalized by face height
            ys = [lm[i].y for i in range(len(lm))]
            ratios.append(np.std(ys))
        if len(ratios) < 2: return 0.0
        return float(np.mean(ratios))*1000.0  # scaled

def laplacian_var_gray(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return cv2.Laplacian(g, cv2.CV_64F).var()

def embedding_variance(embs):
    embs = [e for e in embs if e is not None]
    if len(embs) < 2: return 1.0
    # compute pairwise distances
    dists=[]
    for i in range(1,len(embs)):
        dists.append(np.linalg.norm(embs[i]-embs[0]))
    return float(np.mean(dists))

def dummy_cnn_score(crop):
    # placeholder: you should replace with a real CNN prediction
    # we use Laplacian var normalized: more blur -> higher suspicion
    lv = laplacian_var_gray(crop)
    # map lv (low) -> suspicious higher score
    score = max(0, min(1.0, (200.0 - lv) / 200.0))
    return score

def aggregate(frames):
    # per-face embedding stability, cnn scores, blink proxy
    embeddings=[]
    cnn_scores=[]
    blur_scores=[]
    face_count = 0
    for f in frames:
        crops = face_crops_from_frame(f)
        if not crops: continue
        face_count += len(crops)
        # for demo, pick first face
        box, crop = crops[0]
        emb = compute_face_embedding(crop)
        embeddings.append(emb)
        cnn_scores.append(dummy_cnn_score(crop))
        blur_scores.append(laplacian_var_gray(crop))
    emb_var = embedding_variance(embeddings)
    cnn_mean = float(np.mean(cnn_scores)) if cnn_scores else 0.5
    blur_mean = float(np.mean(blur_scores)) if blur_scores else 1000.0
    blink_proxy = blink_rate(frames)
    # weights tuned by heuristics
    # higher emb_var -> suspicious, higher cnn_mean -> suspicious, blink_proxy low->suspicious
    s_emb = min(1.0, emb_var / 0.6)  # tune
    s_cnn = cnn_mean
    s_blink = 1.0 if blink_proxy < 0.03 else 0.0  # placeholder
    combined = 0.45*s_emb + 0.35*s_cnn + 0.2*s_blink
    prob = float(max(0.0, min(1.0, combined)))
    return prob*100.0, {
        "emb_var": s_emb,
        "cnn_mean": s_cnn,
        "blink_proxy": blink_proxy,
        "face_samples": face_count
    }

def detect(video_path):
    if not os.path.exists(video_path):
        return {"error":"no file"}
    frames = get_frames(video_path, max_frames=60, resize=(480,320))
    if len(frames) < 6:
        return {"error":"video too short"}
    prob, details = aggregate(frames)
    is_deepfake = prob > 50
    return {"type":"video", "isDeepfake": is_deepfake, "confidence": int(prob if is_deepfake else 100-prob), "details": details}

if __name__=='__main__':
    import sys, json
    path = sys.argv[1]
    r = detect(path)
    print(json.dumps(r))
