-- A canal site (either marker) yields exactly what the same land yields with no feature: every featureless row, copied for the marker.
INSERT INTO TerrainBiomeFeature_YieldChanges (BiomeType, FeatureType, TerrainType, YieldType, ScaleByGameAge, YieldChange)
SELECT BiomeType, 'FEATURE_CANALS_SITE', TerrainType, YieldType, ScaleByGameAge, YieldChange
FROM TerrainBiomeFeature_YieldChanges WHERE FeatureType IS NULL;

INSERT INTO TerrainBiomeFeature_YieldChanges (BiomeType, FeatureType, TerrainType, YieldType, ScaleByGameAge, YieldChange)
SELECT BiomeType, 'FEATURE_CANALS_SITE_ONE_TILE', TerrainType, YieldType, ScaleByGameAge, YieldChange
FROM TerrainBiomeFeature_YieldChanges WHERE FeatureType IS NULL;
