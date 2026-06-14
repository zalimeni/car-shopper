// Storage wrapper — uses localStorage (persists across sessions, no artifact sandbox limits)
// API mirrors window.storage.get/set/delete for easy migration

var storage = {
  async get(key) {
    try {
      var val = localStorage.getItem(key);
      if (val === null) return null;
      return { key: key, value: val };
    } catch (e) {
      console.error("storage.get error:", e);
      return null;
    }
  },

  async set(key, value) {
    try {
      localStorage.setItem(key, value);
      return { key: key, value: value };
    } catch (e) {
      console.error("storage.set error:", e);
      return null;
    }
  },

  async delete(key) {
    try {
      localStorage.removeItem(key);
      return { key: key, deleted: true };
    } catch (e) {
      console.error("storage.delete error:", e);
      return null;
    }
  },
};

export default storage;
