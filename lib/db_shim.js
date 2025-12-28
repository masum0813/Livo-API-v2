import { cacheGet, cacheSet } from "./cache.js";

const CACHE_INTERVAL_SECONDS = 30 * 24 * 60 * 60;

function makeBinder(sql, env) {
  const bound = { params: [] };
  return {
    bind(...params) {
      bound.params = params;
      return this;
    },
    async first() {
      try {
        // movies_by_channel
        if (sql.includes("FROM movies_by_channel")) {
          const channelId = bound.params[0];
          const language = bound.params[1] || "";
          const key = `/movies/channel/${channelId}?lang=${language}`;
          const v = await cacheGet(env, key);
          return v || null;
        }

        // movies_by_id
        if (sql.includes("FROM movies_by_id")) {
          const tmdbId = bound.params[0];
          const language = bound.params[1] || "";
          const key = `/movies/id/${tmdbId}?lang=${language}`;
          const v = await cacheGet(env, key);
          return v || null;
        }

        // series_by_id
        if (sql.includes("FROM series_by_id")) {
          const tmdbId = bound.params[0];
          const language = bound.params[1] || "";
          const key = `/series/id/${tmdbId}?lang=${language}`;
          const v = await cacheGet(env, key);
          return v || null;
        }

        // single episode
        if (sql.includes("FROM series_episodes") && sql.includes("LIMIT 1")) {
          const seriesId = bound.params[0];
          const language = bound.params[1] || "";
          const seasonNumber = bound.params[2];
          const episodeNumber = bound.params[3];
          const key = `/series/${seriesId}/season/${seasonNumber}/episodes?lang=${language}`;
          const episodes = (await cacheGet(env, key)) || [];
          const ep = episodes.find((e) => Number(e.episode_number) === Number(episodeNumber));
          return ep || null;
        }

        return null;
      } catch (e) {
        return null;
      }
    },
    async all() {
      try {
        // seasons list
        if (sql.includes("FROM series_seasons")) {
          const seriesId = bound.params[0];
          const language = bound.params[1] || "";
          const key = `/series/${seriesId}/seasons?lang=${language}`;
          const arr = (await cacheGet(env, key)) || [];
          return { results: arr };
        }

        // episodes list
        if (sql.includes("FROM series_episodes") && sql.includes("ORDER BY episode_number")) {
          const seriesId = bound.params[0];
          const language = bound.params[1] || "";
          const seasonNumber = bound.params[2];
          const key = `/series/${seriesId}/season/${seasonNumber}/episodes?lang=${language}`;
          const arr = (await cacheGet(env, key)) || [];
          return { results: arr };
        }

        // guest stars flattened
        if (sql.includes("FROM episode_guest_stars")) {
          const seriesId = bound.params[0];
          const language = bound.params[1] || "";
          const seasonNumber = bound.params[2];
          const key = `/series/${seriesId}/season/${seasonNumber}/episodes?lang=${language}`;
          const episodes = (await cacheGet(env, key)) || [];
          const guests = [];
          for (const ep of episodes) {
            const list = Array.isArray(ep.guest_stars) ? ep.guest_stars : [];
            for (const g of list) {
              guests.push({
                episode_id: ep.episode_id ?? ep.id,
                episode_number: ep.episode_number,
                guest_id: g.id,
                name: g.name,
                original_name: g.original_name,
                character: g.character,
                profile_path: g.profile_path,
                order_index: g.order ?? null,
              });
            }
          }
          return { results: guests };
        }

        return { results: [] };
      } catch (e) {
        return { results: [] };
      }
    },
    async run() {
      try {
        // insert / upsert movies_by_channel
        if (sql.includes("INSERT INTO movies_by_channel")) {
          const [channelId, language, tmdbId, title, overview, release_date, poster_path, genres, rating, rating_count, director_name, cast_names, cast_profile_paths, updated_at] = bound.params;
          const key = `/movies/channel/${channelId}?lang=${language || ""}`;
          const row = {
            tmdb_id: tmdbId,
            title,
            overview,
            release_date,
            poster_path,
            genres: genres || "[]",
            rating,
            rating_count,
            director_name,
            cast_names: cast_names || "[]",
            cast_profile_paths: cast_profile_paths || "[]",
            updated_at,
          };
          await cacheSet(env, key, row, CACHE_INTERVAL_SECONDS);
          return;
        }

        // insert / upsert movies_by_id
        if (sql.includes("INSERT INTO movies_by_id")) {
          const [tmdbId, language, title, overview, release_date, poster_path, genres, rating, rating_count, director_name, cast_names, cast_profile_paths, updated_at] = bound.params;
          const key = `/movies/id/${tmdbId}?lang=${language || ""}`;
          const row = {
            tmdb_id: tmdbId,
            title,
            overview,
            release_date,
            poster_path,
            genres: genres || "[]",
            rating,
            rating_count,
            director_name,
            cast_names: cast_names || "[]",
            cast_profile_paths: cast_profile_paths || "[]",
            updated_at,
          };
          await cacheSet(env, key, row, CACHE_INTERVAL_SECONDS);
          return;
        }

        // insert / upsert series_by_id
        if (sql.includes("INSERT INTO series_by_id")) {
          const [tmdbId, language, genre_ids, original_language, overview, original_name, created_by, number_of_episodes, number_of_seasons, poster_path, first_air_date, name, vote_average, vote_count, updated_at] = bound.params;
          const key = `/series/id/${tmdbId}?lang=${language || ""}`;
          const row = {
            tmdb_id: tmdbId,
            genre_ids: genre_ids || "[]",
            original_language,
            overview,
            original_name,
            created_by: created_by || "[]",
            number_of_episodes,
            number_of_seasons,
            poster_path,
            first_air_date,
            name,
            vote_average,
            vote_count,
            updated_at,
          };
          await cacheSet(env, key, row, CACHE_INTERVAL_SECONDS);
          return;
        }

        // insert / upsert series_seasons
        if (sql.includes("INSERT INTO series_seasons")) {
          const [seriesId, language, season_id, season_number, name, overview, poster_path, air_date, episode_count, vote_average, updated_at] = bound.params;
          const key = `/series/${seriesId}/seasons?lang=${language || ""}`;
          const arr = (await cacheGet(env, key)) || [];
          const season = {
            id: season_id,
            season_number,
            name,
            overview,
            poster_path,
            air_date,
            episode_count,
            vote_average,
            updated_at,
          };
          const idx = arr.findIndex((s) => Number(s.id) === Number(season_id));
          if (idx >= 0) arr[idx] = season; else arr.push(season);
          await cacheSet(env, key, arr, CACHE_INTERVAL_SECONDS);
          return;
        }

        // insert / upsert series_episodes
        if (sql.includes("INSERT INTO series_episodes")) {
          const [seriesId, language, season_number, episode_id, episode_number, name, overview, still_path, air_date, vote_average, vote_count, updated_at] = bound.params;
          const key = `/series/${seriesId}/season/${season_number}/episodes?lang=${language || ""}`;
          const arr = (await cacheGet(env, key)) || [];
          const ep = {
            series_id: seriesId,
            id: episode_id,
            episode_id: episode_id,
            episode_number,
            name,
            overview,
            still_path,
            air_date,
            vote_average,
            vote_count,
            updated_at,
            guest_stars: (arr.find((e) => Number(e.episode_id) === Number(episode_id))?.guest_stars) || [],
          };
          const idx = arr.findIndex((e) => Number(e.episode_id) === Number(episode_id));
          if (idx >= 0) arr[idx] = ep; else arr.push(ep);
          await cacheSet(env, key, arr, CACHE_INTERVAL_SECONDS);
          return;
        }

        // insert / upsert episode_guest_stars
        if (sql.includes("INSERT INTO episode_guest_stars")) {
          const [seriesId, language, season_number, episode_id, episode_number, guest_id, name, original_name, character, profile_path, order_index, updated_at] = bound.params;
          const key = `/series/${seriesId}/season/${season_number}/episodes?lang=${language || ""}`;
          const arr = (await cacheGet(env, key)) || [];
          const idx = arr.findIndex((e) => Number(e.episode_id) === Number(episode_id));
          if (idx < 0) {
            // create a placeholder episode entry
            arr.push({ series_id: seriesId, id: episode_id, episode_id, episode_number, guest_stars: [] });
          }
          const episode = arr.find((e) => Number(e.episode_id) === Number(episode_id));
          episode.guest_stars = episode.guest_stars || [];
          const guest = {
            id: guest_id,
            name,
            original_name,
            character,
            profile_path,
            order: order_index,
          };
          const gidx = episode.guest_stars.findIndex((g) => Number(g.id) === Number(guest_id));
          if (gidx >= 0) episode.guest_stars[gidx] = guest; else episode.guest_stars.push(guest);
          await cacheSet(env, key, arr, CACHE_INTERVAL_SECONDS);
          return;
        }

        return;
      } catch (e) {
        return;
      }
    },
  };
}

export function createDbShim(env) {
  return {
    prepare(sql) {
      return makeBinder(sql, env);
    },
  };
}
