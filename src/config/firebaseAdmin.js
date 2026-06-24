// import admin from 'firebase-admin';
// import fs from 'fs';

// const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
// const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
// const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
// const googleApplicationCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
// const hasServiceAccount = Boolean(projectId && clientEmail && privateKey);
// const hasApplicationCredentials = Boolean(googleApplicationCredentials);
// let firebaseAdminReady = false;
// let firebaseAdminMode = 'none';

// if (!admin.apps.length) {
//   if (hasServiceAccount) {
//     admin.initializeApp({
//       credential: admin.credential.cert({
//         projectId,
//         clientEmail,
//         privateKey,
//       }),
//     });
//     firebaseAdminReady = true;
//     firebaseAdminMode = 'service-account';
//     console.log('Firebase Admin initialized using explicit service account credentials.');
//   } else if (hasApplicationCredentials) {
//     const credentialsExist = fs.existsSync(googleApplicationCredentials);
//     if (!credentialsExist) {
//       const error = new Error(
//         `GOOGLE_APPLICATION_CREDENTIALS file not found at ${googleApplicationCredentials}`
//       );
//       console.error('Firebase Admin initialization error:', {
//         message: error.message,
//         GOOGLE_APPLICATION_CREDENTIALS: googleApplicationCredentials,
//       });
//       throw error;
//     }

//     admin.initializeApp({
//       credential: admin.credential.applicationDefault(),
//     });
//     firebaseAdminReady = true;
//     firebaseAdminMode = 'application-default';
//     console.log('Firebase Admin initialized using GOOGLE_APPLICATION_CREDENTIALS.');
//   } else {
//     const error = new Error(
//       'Firebase Admin SDK is misconfigured. Provide FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, or GOOGLE_APPLICATION_CREDENTIALS in backend/.env.'
//     );
//     console.error('Firebase Admin initialization error:', {
//       message: error.message,
//       FIREBASE_PROJECT_ID: Boolean(projectId),
//       FIREBASE_CLIENT_EMAIL: Boolean(clientEmail),
//       FIREBASE_PRIVATE_KEY: Boolean(process.env.FIREBASE_PRIVATE_KEY),
//       GOOGLE_APPLICATION_CREDENTIALS: googleApplicationCredentials,
//     });
//     throw error;
//   }
// }

// const firebaseAuth = admin.auth();
// export { firebaseAdminReady, firebaseAdminMode };
// export default firebaseAuth;


import admin from "firebase-admin";
import fs from "fs";

const cleanEnv = (value) => value?.trim();

const googleApplicationCredentials = cleanEnv(
  process.env.GOOGLE_APPLICATION_CREDENTIALS
);

let firebaseAdminReady = false;
let firebaseAdminMode = "none";

try {
  if (!admin.apps.length) {
    if (!googleApplicationCredentials) {
      throw new Error(
        "Firebase Admin SDK is misconfigured. Provide GOOGLE_APPLICATION_CREDENTIALS with the absolute path to your Firebase service account JSON file."
      );
    }

    const credentialsExist = fs.existsSync(googleApplicationCredentials);

    if (!credentialsExist) {
      throw new Error(
        `GOOGLE_APPLICATION_CREDENTIALS file not found at ${googleApplicationCredentials}`
      );
    }

    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });

    firebaseAdminReady = true;
    firebaseAdminMode = "application-default";
    console.log("Firebase Admin initialized using GOOGLE_APPLICATION_CREDENTIALS.");
  } else {
    firebaseAdminReady = true;
    firebaseAdminMode = "existing-app";
  }
} catch (error) {
  console.error("Firebase Admin initialization error:", {
    message: error.message,
    GOOGLE_APPLICATION_CREDENTIALS: googleApplicationCredentials || null,
  });

  throw error;
}

const firebaseAuth = admin.auth();

export { firebaseAdminReady, firebaseAdminMode };
export default firebaseAuth;
