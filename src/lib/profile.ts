/**
 * A user's own profile: display name, email, avatar, password. Screens call
 * these; they never touch `@/lib/supabase` directly for this, matching every
 * other `lib/*` module.
 */
import { decode } from 'base64-arraybuffer';
import * as ImagePicker from 'expo-image-picker';

import { CHECK_VIOLATION, isPostgrestError } from '@/lib/postgrest';
import { supabase } from '@/lib/supabase';

export type Profile = {
  id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
};

const PROFILE_COLUMNS = 'id, display_name, email, avatar_url';

/** The signed-in user's own profile row. */
export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('users')
    .select(PROFILE_COLUMNS)
    .eq('id', userId)
    .maybeSingle<Profile>();

  if (error) {
    throw new Error(`Could not load your profile. ${error.message}`);
  }

  return data;
}

/** Change the name shown on leaderboards and in games. */
export async function updateDisplayName(userId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  const { error } = await supabase.from('users').update({ display_name: trimmed }).eq('id', userId);

  if (error) {
    if (isPostgrestError(error) && error.code === CHECK_VIOLATION) {
      throw new Error('Give yourself a real name.');
    }
    throw new Error(`Could not update your name. ${error.message}`);
  }
}

/**
 * Change the signed-in user's password. Needs no "current password" field -
 * the request is already authenticated as them, so Supabase does not ask for one.
 */
export async function changePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Let the user pick a photo from their device and upload it as their avatar,
 * returning the new public URL - or null if they cancelled the picker, which is
 * not an error, just nothing to do.
 *
 * Every avatar lives at "<user_id>/avatar.jpg" in the public `avatars` bucket
 * (see the migration): re-uploading always overwrites the same object rather
 * than accumulating old photos, and the fixed extension means every upload is
 * re-encoded to JPEG regardless of the source format. The returned URL carries a
 * cache-busting query param, since the object path never changes on a
 * re-upload - without it, a client (or a CDN in front of the bucket) that had
 * already cached the old image at that exact URL would keep showing it.
 */
export async function pickAndUploadAvatar(userId: string): Promise<string | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Photo library access is needed to set a profile picture.');
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.7,
    base64: true,
  });

  if (result.canceled || !result.assets[0]?.base64) {
    return null;
  }

  const path = `${userId}/avatar.jpg`;
  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, decode(result.assets[0].base64), {
      contentType: 'image/jpeg',
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Could not upload your photo. ${uploadError.message}`);
  }

  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  const avatarUrl = `${data.publicUrl}?t=${Date.now()}`;

  const { error: updateError } = await supabase
    .from('users')
    .update({ avatar_url: avatarUrl })
    .eq('id', userId);

  if (updateError) {
    throw new Error(
      `Uploaded your photo, but could not save it to your profile. ${updateError.message}`
    );
  }

  return avatarUrl;
}
