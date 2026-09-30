// Runs before each unit test file. `@react-native-async-storage/async-storage`'s
// jest mock (imported below) is just a plain object - it has to be wired in via
// jest.mock() to actually replace the real native module, which is null under
// Jest (there is no native runtime). Without this, any test that imports
// src/lib/supabase.ts transitively - which most of src/lib does - crashes with
// "[@RNC/AsyncStorage]: NativeModule: AsyncStorage is null."
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
