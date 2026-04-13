import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, collection, addDoc, query, where, orderBy, onSnapshot, deleteDoc, doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// Fetch Firebase config
let firebaseConfig;
try {
  const response = await fetch('./firebase-applet-config.json');
  firebaseConfig = await response.json();
} catch (error) {
  console.error("Failed to load firebase-applet-config.json", error);
  firebaseConfig = {};
}

// Check if Firebase is configured (not using placeholders)
const isFirebaseConfigured = firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY";

// Initialize Firebase only if configured
let app, auth, db;
if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = firebaseConfig.firestoreDatabaseId ? getFirestore(app, firebaseConfig.firestoreDatabaseId) : getFirestore(app);
}

/**
 * Handles Firestore errors by throwing a structured JSON error.
 * @param {Error} error - The caught error.
 * @param {string} operationType - The type of operation (e.g., 'create', 'update', 'delete', 'list', 'get', 'write').
 * @param {string|null} path - The Firestore path involved.
 */
function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// DOM Elements
const newNoteBtn = document.getElementById('new-note-btn');
const notesList = document.getElementById('notes-list');
const emptyState = document.getElementById('empty-state');
const editorContainer = document.getElementById('editor-container');
const noteTitleInput = document.getElementById('note-title');
const noteContentInput = document.getElementById('note-content');
const noteCreationDate = document.getElementById('note-creation-date');
const pinNoteBtn = document.getElementById('pin-note-btn');
const deleteNoteBtn = document.getElementById('delete-note-btn');
const formatBtns = document.querySelectorAll('.format-tools button[data-command]');
const insertImageBtn = document.getElementById('insert-image-btn');
const imageUploadInput = document.getElementById('image-upload-input');
const confirmModal = document.getElementById('confirm-modal');
const cancelDeleteBtn = document.getElementById('cancel-delete');
const confirmDeleteBtn = document.getElementById('confirm-delete');
const authOverlay = document.getElementById('auth-overlay');
const googleLoginBtn = document.getElementById('google-login-btn');
const sidebarFooter = document.getElementById('sidebar-footer');
const userAvatar = document.getElementById('user-avatar');
const userName = document.getElementById('user-name');
const logoutBtn = document.getElementById('logout-btn');

// State
let currentUserUid = null;
let notesData = [];
let currentNoteId = null;
let saveTimeout = null;
let unsubscribeNotes = null;

/**
 * Authenticates the user with Google and sets up listeners.
 */
async function initAuth() {
  if (!isFirebaseConfigured) {
    console.warn("Firebase is not configured. Please update firebase-applet-config.json");
    emptyState.innerHTML = '<p>⚠️ Добавьте ключи Firebase в <code>firebase-applet-config.json</code> для работы приложения.</p>';
    return;
  }

  onAuthStateChanged(auth, (user) => {
    if (user) {
      currentUserUid = user.uid;
      authOverlay.classList.add('hidden');
      sidebarFooter.classList.remove('hidden');
      userAvatar.src = user.photoURL || 'https://via.placeholder.com/32';
      userName.textContent = user.displayName || 'Пользователь';
      setupNotesListener();
    } else {
      currentUserUid = null;
      authOverlay.classList.remove('hidden');
      sidebarFooter.classList.add('hidden');
      notesData = [];
      renderNotesList();
      closeEditor();
      if (unsubscribeNotes) {
        unsubscribeNotes();
        unsubscribeNotes = null;
      }
    }
  });
}

async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    console.error(`Auth Error: ${error.message}`);
    alert('Ошибка авторизации');
  }
}

async function logout() {
  try {
    await signOut(auth);
  } catch (error) {
    console.error(`Logout Error: ${error.message}`);
  }
}

/**
 * Sets up a real-time listener for the user's notes.
 */
function setupNotesListener() {
  if (!currentUserUid) return;

  if (unsubscribeNotes) {
    unsubscribeNotes();
  }

  const q = query(
    collection(db, "notes"),
    where("uid", "==", currentUserUid),
    orderBy("updatedAt", "desc")
  );

  unsubscribeNotes = onSnapshot(q, (snapshot) => {
    notesData = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    // Sort: pinned first, then by updatedAt desc
    notesData.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return b.updatedAt - a.updatedAt;
    });

    renderNotesList();
    
    // If current note was deleted remotely, clear editor
    if (currentNoteId && !notesData.find(n => n.id === currentNoteId)) {
      closeEditor();
    }
  }, (error) => {
    handleFirestoreError(error, 'list', 'notes');
  });
}

/**
 * Renders the list of notes in the sidebar.
 */
function renderNotesList() {
  notesList.innerHTML = '';

  notesData.forEach(note => {
    const li = document.createElement('div');
    li.className = `note-item ${note.id === currentNoteId ? 'selected' : ''}`;
    li.dataset.id = note.id;
    
    const dateObj = note.updatedAt ? new Date(note.updatedAt) : new Date();
    const formattedDate = dateObj.toLocaleDateString('ru-RU');

    const title = note.title || 'Новая заметка';
    const snippet = note.plainText || 'Нет текста';
    const pinIcon = note.isPinned ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.68V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3v4.68a2 2 0 0 1-1.11 1.87l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>' : '';

    li.innerHTML = `
      <div class="note-item-title">${pinIcon}${escapeHtml(title)}</div>
      <div class="note-item-meta">${formattedDate}</div>
      <div class="note-item-snippet">${escapeHtml(snippet)}</div>
    `;

    li.addEventListener('click', () => openNote(note.id));
    notesList.appendChild(li);
  });
}

/**
 * Creates a new note.
 */
async function createNewNote() {
  if (!isFirebaseConfigured) {
    alert('Пожалуйста, добавьте ключи Firebase в файл firebase-config.js');
    return;
  }
  if (!currentUserUid) return;
  
  if (notesData.length >= 500) {
    alert('Достигнут лимит в 500 заметок.');
    return;
  }

  const newNote = {
    uid: currentUserUid,
    title: '',
    content: '',
    plainText: '',
    isPinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  try {
    const docRef = await addDoc(collection(db, "notes"), newNote);
    openNote(docRef.id, newNote);
  } catch (error) {
    handleFirestoreError(error, 'create', 'notes');
  }
}

/**
 * Opens a note in the editor.
 * @param {string} id - Note ID
 * @param {Object} [optimisticData] - Optional data for immediate render
 */
function openNote(id, optimisticData = null) {
  currentNoteId = id;
  const note = notesData.find(n => n.id === id) || optimisticData;
  
  if (!note) return;

  emptyState.classList.add('hidden');
  editorContainer.classList.remove('hidden');
  
  noteTitleInput.value = note.title || '';
  noteContentInput.innerHTML = note.content || '';
  
  if (note.createdAt) {
    const dateObj = new Date(note.createdAt);
    const dateStr = dateObj.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const timeStr = dateObj.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    noteCreationDate.textContent = `Создано: ${dateStr} в ${timeStr}`;
  } else {
    noteCreationDate.textContent = '';
  }
  
  updatePinButtonState(note.isPinned);
  renderNotesList(); // Update selected state
}

/**
 * Closes the editor and shows empty state.
 */
function closeEditor() {
  currentNoteId = null;
  emptyState.classList.remove('hidden');
  editorContainer.classList.add('hidden');
  noteTitleInput.value = '';
  noteContentInput.innerHTML = '';
  renderNotesList();
}

/**
 * Saves the current note to Firestore.
 */
async function saveCurrentNote() {
  if (!currentNoteId) return;

  const title = noteTitleInput.value;
  const content = noteContentInput.innerHTML;
  const plainText = noteContentInput.innerText.substring(0, 100).replace(/\n/g, ' '); // Snippet

  // Check length limit (50000 chars)
  if (content.length > 50000) {
    alert('Максимальная длина заметки — 50000 символов.');
    return;
  }

  try {
    await updateDoc(doc(db, "notes", currentNoteId), {
      title,
      content,
      plainText,
      updatedAt: Date.now()
    });
  } catch (error) {
    handleFirestoreError(error, 'update', `notes/${currentNoteId}`);
  }
}

/**
 * Debounces the save function.
 */
function handleInput() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveCurrentNote, 1000);
}

/**
 * Toggles the pinned state of the current note.
 */
async function togglePin() {
  if (!currentNoteId) return;
  
  const note = notesData.find(n => n.id === currentNoteId);
  if (!note) return;

  const newPinnedState = !note.isPinned;
  
  try {
    await updateDoc(doc(db, "notes", currentNoteId), {
      isPinned: newPinnedState,
      updatedAt: Date.now()
    });
    updatePinButtonState(newPinnedState);
  } catch (error) {
    handleFirestoreError(error, 'update', `notes/${currentNoteId}`);
  }
}

function updatePinButtonState(isPinned) {
  if (isPinned) {
    pinNoteBtn.classList.add('active');
  } else {
    pinNoteBtn.classList.remove('active');
  }
}

/**
 * Opens the delete confirmation modal.
 */
function promptDelete() {
  if (!currentNoteId) return;
  confirmModal.classList.remove('hidden');
}

/**
 * Closes the delete confirmation modal.
 */
function closeDeleteModal() {
  confirmModal.classList.add('hidden');
}

/**
 * Deletes the current note from Firestore.
 */
async function confirmDelete() {
  if (!currentNoteId) return;
  
  const idToDelete = currentNoteId;
  closeDeleteModal();

  try {
    await deleteDoc(doc(db, "notes", idToDelete));
    if (currentNoteId === idToDelete) {
      closeEditor();
    }
  } catch (error) {
    handleFirestoreError(error, 'delete', `notes/${idToDelete}`);
  }
}

/**
 * Applies text formatting commands.
 * @param {string} command - The command to execute
 */
function formatText(command) {
  document.execCommand(command, false, null);
  noteContentInput.focus();
  handleInput();
}

/**
 * Handles image upload and insertion via Base64 (compressed).
 */
function handleImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      let width = img.width;
      let height = img.height;
      const MAX_WIDTH = 800;
      
      if (width > MAX_WIDTH) {
        height *= MAX_WIDTH / width;
        width = MAX_WIDTH;
      }
      
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      
      // Compress to JPEG to save space
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      
      noteContentInput.focus();
      document.execCommand('insertImage', false, dataUrl);
      handleInput();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  
  // Reset input
  event.target.value = '';
}

/**
 * Escapes HTML to prevent XSS in the sidebar.
 * @param {string} str - The string to escape
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Event Listeners
newNoteBtn.addEventListener('click', createNewNote);
noteTitleInput.addEventListener('input', handleInput);
noteContentInput.addEventListener('input', handleInput);
pinNoteBtn.addEventListener('click', togglePin);
deleteNoteBtn.addEventListener('click', promptDelete);
cancelDeleteBtn.addEventListener('click', closeDeleteModal);
confirmDeleteBtn.addEventListener('click', confirmDelete);
googleLoginBtn.addEventListener('click', loginWithGoogle);
logoutBtn.addEventListener('click', logout);
insertImageBtn.addEventListener('click', () => imageUploadInput.click());
imageUploadInput.addEventListener('change', handleImageUpload);

formatBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    formatText(btn.dataset.command);
  });
});

// Hotkeys
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && e.code === 'KeyN') {
    e.preventDefault();
    createNewNote();
  }
});

// Initialize
initAuth();
