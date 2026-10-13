export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  thumb: string;
  art: string;
  kind: "song" | "video";
}

export interface Playlist {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tracks: Track[];
}

export interface Library {
  favorites: Track[];
  playlists: Playlist[];
  history: Track[];
}

export interface Genre {
  id: string;
  name: string;
}

export interface GenreArtist {
  id: string;
  name: string;
  /** Cover of one of their releases in the genre. */
  thumb: string;
  art: string;
  /** A few of their songs in the genre. */
  hits: string[];
}

export interface GenrePage {
  id: string;
  name: string;
  /** First page of artists; `api.genreArtists` brings the next ones. */
  artists: GenreArtist[];
  hasMoreArtists: boolean;
  tracks: Track[];
}

export interface ArtistPage {
  id: string;
  name: string;
  description: string;
  banner: string;
  tracks: Track[];
}
